import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { claimPublishOperation, type PublishLimits } from "./claim.js";
import { reconcileUnknownPublishRoutes } from "./scheduling.js";

const connectionString = process.env.GATEWAY_TEST_DATABASE_URL;
const pool = connectionString ? new Pool({ connectionString }) : null;
const limits: PublishLimits = {
  maxSiteLeases: 1,
  maxWorkspaceLeases: 2,
  maxGlobalLeases: 4,
  siteStartIntervalMs: 5_000,
};

const workspaceId = randomUUID();
const siteA = randomUUID();
const siteB = randomUUID();
const siteC = randomUUID();

before(async () => {
  if (!pool) return;
  await pool.query(
    'INSERT INTO "Workspace" ("id","name","updatedAt") VALUES ($1,$2,now())',
    [workspaceId, "fairness"],
  );
  await pool.query(
    'INSERT INTO "Site" ("id","workspaceId","updatedAt") VALUES ($1,$4,now()),($2,$4,now()),($3,$4,now())',
    [siteA, siteB, siteC, workspaceId],
  );
  for (const [siteId, releaseId] of [
    [siteA, "a"],
    [siteB, "b"],
    [siteC, "c"],
  ] as const) {
    await pool.query(
      'INSERT INTO "Release" ("id","siteId","releaseId","checksum","metadata","snapshotRef") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [randomUUID(), siteId, releaseId, "sha256:test", "{}", "/test/snapshot"],
    );
  }
});

after(async () => {
  if (!pool) return;
  await pool.query(
    'DELETE FROM "ActiveDeployment" WHERE "siteId" IN ($1,$2,$3)',
    [siteA, siteB, siteC],
  );
  await pool.query('DELETE FROM "DomainChange" WHERE "siteId" IN ($1,$2,$3)', [
    siteA,
    siteB,
    siteC,
  ]);
  await pool.query('DELETE FROM "Domain" WHERE "siteId" IN ($1,$2,$3)', [
    siteA,
    siteB,
    siteC,
  ]);
  await pool.query('DELETE FROM "PublishOperation" WHERE "workspaceId"=$1', [
    workspaceId,
  ]);
  await pool.query('DELETE FROM "Release" WHERE "siteId" IN ($1,$2,$3)', [
    siteA,
    siteB,
    siteC,
  ]);
  await pool.query('DELETE FROM "Site" WHERE "id" IN ($1,$2,$3)', [
    siteA,
    siteB,
    siteC,
  ]);
  await pool.query('DELETE FROM "Workspace" WHERE "id"=$1', [workspaceId]);
  await pool.end();
});

async function insertOperation(
  siteId: string,
  releaseId: string,
  revision: number,
) {
  return insertOperationForWorkspace(workspaceId, siteId, releaseId, revision);
}

async function insertOperationForWorkspace(
  ownerWorkspaceId: string,
  siteId: string,
  releaseId: string,
  revision: number,
) {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO "PublishOperation"
    ("id","workspaceId","siteId","idempotencyKey","releaseId","expectedRevision","desiredRevision","updatedAt")
    VALUES ($1,$2,$3,$4,$5,$6,$6,now())`,
    [id, ownerWorkspaceId, siteId, randomUUID(), releaseId, revision],
  );
  return id;
}

test(
  "claims fairly across sites and enforces per-site/workspace capacity",
  { skip: !pool },
  async () => {
    const a: string[] = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        insertOperation(siteA, "a", index + 1),
      ),
    );
    const b = await insertOperation(siteB, "b", 1);

    const first = await claimPublishOperation(pool!, "worker-a", 60, limits);
    const second = await claimPublishOperation(pool!, "worker-b", 60, limits);
    const overCapacity = await claimPublishOperation(
      pool!,
      "worker-c",
      60,
      limits,
    );
    assert.equal(first?.siteId, siteA);
    assert.equal(second?.siteId, siteB);
    assert.equal(overCapacity, null);

    await pool!.query(
      'UPDATE "PublishOperation" SET "leaseUntil"=now()-interval \'1 second\',"leaseOwner"=NULL WHERE "id" IN ($1,$2)',
      [first!.id, second!.id],
    );
    await pool!.query(
      'UPDATE "Site" SET "lastPublishStartedAt"=now()-interval \'10 seconds\' WHERE "id"=$1',
      [siteA],
    );
    const aSecond = await claimPublishOperation(pool!, "worker-d", 60, limits);
    assert.equal(aSecond?.siteId, siteA);
    assert.ok(a.includes(aSecond!.id));
    assert.notEqual(aSecond?.id, b);
  },
);

test(
  "one valid site lease and stale owners cannot overwrite a newer claim",
  { skip: !pool },
  async () => {
    await pool!.query(
      'UPDATE "PublishOperation" SET "status"=\'failed\',"leaseOwner"=NULL,"leaseUntil"=NULL WHERE "workspaceId"=$1',
      [workspaceId],
    );
    const operation = await insertOperation(siteC, "c", 1);
    const first = await claimPublishOperation(pool!, "owner-old", 60, limits);
    assert.equal(first?.id, operation);
    assert.equal(
      await claimPublishOperation(pool!, "owner-new", 60, limits),
      null,
    );
    await pool!.query(
      'UPDATE "PublishOperation" SET "leaseUntil"=now()-interval \'1 second\' WHERE "id"=$1',
      [operation],
    );
    await pool!.query(
      'UPDATE "Site" SET "lastPublishStartedAt"=now()-interval \'10 seconds\' WHERE "id"=$1',
      [siteC],
    );
    const reclaim = await claimPublishOperation(pool!, "owner-new", 60, limits);
    assert.equal(reclaim?.id, operation);
    assert.equal(reclaim?.attempts, 2);
  },
);

test(
  "reconciles uncertain route outcomes before allowing a retry",
  { skip: !pool },
  async () => {
    await pool!.query(
      'UPDATE "PublishOperation" SET "status"=\'failed\',"leaseOwner"=NULL,"leaseUntil"=NULL WHERE "workspaceId"=$1',
      [workspaceId],
    );
    const targetOperation = await insertOperation(siteA, "a", 10);
    const oldOperation = await insertOperation(siteB, "b", 20);
    const blockedOperation = await insertOperation(siteC, "c", 30);
    await pool!.query(
      `UPDATE "PublishOperation"
    SET "failureCode"='ROUTE_SWITCH_FAILED',"leaseUntil"=now()-interval '1 second'
    WHERE "id" IN ($1,$2,$3)`,
      [targetOperation, oldOperation, blockedOperation],
    );
    await pool!.query(
      `INSERT INTO "ActiveDeployment" ("id","siteId","releaseId","imageDigest","routeRevision")
    VALUES ($1,$3,'a',$5,10),($2,$4,'b',$5,19)`,
      [randomUUID(), randomUUID(), siteA, siteB, `sha256:${"a".repeat(64)}`],
    );
    const routes = new Map<string, { releaseId: string; revision: number }>([
      [siteA, { releaseId: "a", revision: 10 }],
      [siteB, { releaseId: "b", revision: 19 }],
      [siteC, { releaseId: "c", revision: 30 }],
    ]);
    const result = await reconcileUnknownPublishRoutes(pool!, {
      readRoute: async (siteId) => routes.get(siteId),
    });
    assert.deepEqual(result, { settled: 2, pending: 1 });
    const statuses = await pool!.query(
      'SELECT "id","status","failureCode","nextAttemptAt" FROM "PublishOperation" WHERE "id" IN ($1,$2,$3)',
      [targetOperation, oldOperation, blockedOperation],
    );
    const byId = new Map(statuses.rows.map((row) => [row.id, row]));
    assert.equal(byId.get(targetOperation).status, "ready");
    assert.equal(byId.get(targetOperation).failureCode, null);
    assert.equal(byId.get(oldOperation).status, "pending");
    assert.equal(byId.get(oldOperation).failureCode, null);
    assert.ok(byId.get(oldOperation).nextAttemptAt);
    assert.equal(byId.get(blockedOperation).status, "pending");
    assert.equal(byId.get(blockedOperation).failureCode, "ROUTE_SWITCH_FAILED");
    assert.equal(
      await claimPublishOperation(pool!, "after-reconcile", 60, limits),
      null,
    );
  },
);

test(
  "enforces global capacity across workspaces without violating workspace limits",
  { skip: !pool },
  async () => {
    await pool!.query(
      'UPDATE "PublishOperation" SET "status"=\'failed\',"leaseOwner"=NULL,"leaseUntil"=NULL WHERE "status"=\'pending\'',
    );
    const workspaceB = randomUUID();
    const siteD = randomUUID();
    const siteE = randomUUID();
    await pool!.query(
      'INSERT INTO "Workspace" ("id","name","updatedAt") VALUES ($1,$2,now())',
      [workspaceB, "fairness-b"],
    );
    await pool!.query(
      'INSERT INTO "Site" ("id","workspaceId","updatedAt") VALUES ($1,$3,now()),($2,$3,now())',
      [siteD, siteE, workspaceB],
    );
    await pool!.query(
      'INSERT INTO "Release" ("id","siteId","releaseId","checksum","metadata","snapshotRef") VALUES ($1,$2,$5,$8,$6::jsonb,$7),($3,$4,$5,$8,$6::jsonb,$7)',
      [
        randomUUID(),
        siteD,
        randomUUID(),
        siteE,
        "global",
        "{}",
        "/test/snapshot",
        "sha256:test",
      ],
    );
    try {
      for (const [owner, site] of [
        [workspaceId, siteA],
        [workspaceId, siteB],
        [workspaceB, siteD],
        [workspaceB, siteE],
      ] as const) {
        for (let revision = 1; revision <= 3; revision++)
          await insertOperationForWorkspace(owner, site, "global", revision);
      }
      await pool!.query(
        'UPDATE "Site" SET "lastPublishStartedAt"=NULL WHERE "id" IN ($1,$2,$3,$4)',
        [siteA, siteB, siteD, siteE],
      );
      const claimed = await Promise.all(
        Array.from({ length: 7 }, (_, index) =>
          claimPublishOperation(pool!, `global-worker-${index}`, 60, limits),
        ),
      );
      assert.equal(claimed.filter(Boolean).length, 4);
      assert.equal(
        new Set(claimed.filter(Boolean).map((item) => item!.workspaceId)).size,
        2,
      );
      for (const workspace of [workspaceId, workspaceB]) {
        assert.equal(
          claimed.filter((item) => item?.workspaceId === workspace).length,
          2,
        );
      }
      assert.equal(
        await claimPublishOperation(pool!, "global-overflow", 60, limits),
        null,
      );
    } finally {
      await pool!.query(
        'DELETE FROM "PublishOperation" WHERE "workspaceId"=$1',
        [workspaceB],
      );
      await pool!.query('DELETE FROM "Release" WHERE "siteId" IN ($1,$2)', [
        siteD,
        siteE,
      ]);
      await pool!.query('DELETE FROM "Site" WHERE "id" IN ($1,$2)', [
        siteD,
        siteE,
      ]);
      await pool!.query('DELETE FROM "Workspace" WHERE "id"=$1', [workspaceB]);
    }
  },
);

test(
  "a pending domain operation excludes its own site while another site progresses",
  { skip: !pool },
  async () => {
    await pool!.query(
      'UPDATE "PublishOperation" SET "status"=\'failed\',"leaseOwner"=NULL,"leaseUntil"=NULL WHERE "status"=\'pending\'',
    );
    const domainId = randomUUID();
    const domainChangeId = randomUUID();
    const blocked = await insertOperation(siteA, "a", 40);
    const available = await insertOperation(siteB, "b", 41);
    await pool!.query(
      `INSERT INTO "Domain" ("id","siteId","hostname","updatedAt")
    VALUES ($1,$2,$3,now())`,
      [domainId, siteA, `fairness-${domainId}.test`],
    );
    await pool!.query(
      `INSERT INTO "DomainChange" ("siteId","id","domainId","operation","status","updatedAt","retryAfter")
    VALUES ($1,$2,$3,'primary','pending',now(),now())`,
      [siteA, domainChangeId, domainId],
    );
    await pool!.query(
      'UPDATE "Site" SET "lastPublishStartedAt"=NULL WHERE "id" IN ($1,$2)',
      [siteA, siteB],
    );
    try {
      const claim = await claimPublishOperation(
        pool!,
        "domain-aware-worker",
        60,
        limits,
      );
      assert.equal(claim?.id, available);
      assert.equal(
        (
          await pool!.query(
            'SELECT "status" FROM "PublishOperation" WHERE "id"=$1',
            [blocked],
          )
        ).rows[0].status,
        "pending",
      );
    } finally {
      await pool!.query('DELETE FROM "DomainChange" WHERE "id"=$1', [
        domainChangeId,
      ]);
      await pool!.query('DELETE FROM "Domain" WHERE "id"=$1', [domainId]);
    }
  },
);

test(
  "uses the configured per-site lease limit instead of a hardcoded one",
  { skip: !pool },
  async () => {
    await pool!.query(
      'UPDATE "PublishOperation" SET "status"=\'failed\',"leaseOwner"=NULL,"leaseUntil"=NULL WHERE "status"=\'pending\'',
    );
    await insertOperation(siteA, "a", 50);
    await insertOperation(siteA, "a", 51);
    await pool!.query(
      'UPDATE "Site" SET "lastPublishStartedAt"=NULL WHERE "id"=$1',
      [siteA],
    );
    const configured = {
      maxSiteLeases: 2,
      maxWorkspaceLeases: 3,
      maxGlobalLeases: 4,
      siteStartIntervalMs: 1_000,
    };
    const first = await claimPublishOperation(
      pool!,
      "site-limit-1",
      60,
      configured,
    );
    assert.equal(first?.siteId, siteA);
    await pool!.query(
      'UPDATE "Site" SET "lastPublishStartedAt"=now()-interval \'2 seconds\' WHERE "id"=$1',
      [siteA],
    );
    const second = await claimPublishOperation(
      pool!,
      "site-limit-2",
      60,
      configured,
    );
    assert.equal(second?.siteId, siteA);
    await pool!.query(
      'UPDATE "Site" SET "lastPublishStartedAt"=now()-interval \'2 seconds\' WHERE "id"=$1',
      [siteA],
    );
    assert.equal(
      await claimPublishOperation(pool!, "site-limit-3", 60, configured),
      null,
    );
  },
);
