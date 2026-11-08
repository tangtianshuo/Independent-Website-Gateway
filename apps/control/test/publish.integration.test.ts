import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimPublishOperation } from "../../../packages/worker/src/claim";
import type { createPublishOperation as PublishHandler } from "../src/publish";

const connectionString = process.env.GATEWAY_TEST_DATABASE_URL;
const run = connectionString ? describe : describe.skip;

run("publish PostgreSQL integration", () => {
  const pool = new Pool({ connectionString });
  const workspaceId = randomUUID();
  const foreignWorkspaceId = randomUUID();
  const siteId = randomUUID();
  const foreignSiteId = randomUUID();
  const releaseId = "release-one";
  let createPublishOperation: typeof PublishHandler;

  function request(
    key: string,
    expectedRevision = 0,
    id: string = siteId,
    body: Record<string, unknown> = {},
  ) {
    return new Request(
      `http://localhost/api/v1/sites/${id}/publish-operations`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer publish-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          releaseId,
          idempotencyKey: key,
          expectedRevision,
          ...body,
        }),
      },
    );
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = connectionString;
    ({ createPublishOperation } = await import("../src/publish"));
    process.env.CMS_SERVICE_SECRET = "publish-secret";
    process.env.CMS_WORKSPACE_ID = workspaceId;
    await pool.query(
      'INSERT INTO "Workspace" ("id", "name", "updatedAt") VALUES ($1, $2, now()), ($3, $4, now())',
      [workspaceId, "owner", foreignWorkspaceId, "other"],
    );
    await pool.query(
      'INSERT INTO "Site" ("id", "workspaceId", "updatedAt") VALUES ($1, $2, now()), ($3, $4, now())',
      [siteId, workspaceId, foreignSiteId, foreignWorkspaceId],
    );
    await pool.query(
      'INSERT INTO "Release" ("id", "siteId", "releaseId", "checksum", "metadata") VALUES ($1, $2, $3, $4, $5::jsonb)',
      [randomUUID(), siteId, releaseId, "sha256:test", "{}"],
    );
  });

  afterAll(async () => {
    await pool.query(
      'DELETE FROM "PublishOperation" WHERE "siteId" IN ($1, $2)',
      [siteId, foreignSiteId],
    );
    await pool.query('DELETE FROM "Deployment" WHERE "siteId" IN ($1, $2)', [
      siteId,
      foreignSiteId,
    ]);
    await pool.query('DELETE FROM "Publication" WHERE "siteId" IN ($1, $2)', [
      siteId,
      foreignSiteId,
    ]);
    await pool.query(
      'DELETE FROM "ReleaseArtifact" WHERE "siteId" IN ($1, $2)',
      [siteId, foreignSiteId],
    );
    await pool.query('DELETE FROM "Release" WHERE "siteId" = $1', [siteId]);
    await pool.query('DELETE FROM "Site" WHERE "id" IN ($1, $2)', [
      siteId,
      foreignSiteId,
    ]);
    await pool.query('DELETE FROM "Workspace" WHERE "id" IN ($1, $2)', [
      workspaceId,
      foreignWorkspaceId,
    ]);
    await pool.end();
  });

  it("rejects unauthenticated, empty-secret and malformed site requests without a database error", async () => {
    expect(
      (
        await createPublishOperation(
          new Request("http://localhost", { method: "POST" }),
          siteId,
        )
      ).status,
    ).toBe(401);
    const original = process.env.CMS_SERVICE_SECRET;
    process.env.CMS_SERVICE_SECRET = "";
    try {
      expect(
        (
          await createPublishOperation(
            new Request("http://localhost", {
              method: "POST",
              headers: { authorization: "Bearer " },
            }),
            siteId,
          )
        ).status,
      ).toBe(401);
    } finally {
      process.env.CMS_SERVICE_SECRET = original;
    }
    expect(
      (
        await createPublishOperation(
          request("bad-id", 0, "not-a-uuid"),
          "not-a-uuid",
        )
      ).status,
    ).toBe(400);
  });

  it("does not accept a foreign site or a release absent from the owned site", async () => {
    expect(
      (
        await createPublishOperation(
          request("foreign", 0, foreignSiteId),
          foreignSiteId,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await createPublishOperation(
          request("missing", 0, siteId, { releaseId: "unknown" }),
          siteId,
        )
      ).status,
    ).toBe(404);
  });

  it("replays the original operation for the same payload, rejects changed payload and stale revision", async () => {
    const first = await createPublishOperation(request("repeat"), siteId);
    expect(first.status).toBe(201);
    const operation = await first.json();
    expect(operation).toMatchObject({
      releaseId,
      expectedRevision: 0,
      desiredRevision: 1,
      status: "pending",
    });
    await expect(
      (await createPublishOperation(request("repeat"), siteId)).json(),
    ).resolves.toMatchObject({ id: operation.id });
    expect(
      (await createPublishOperation(request("repeat", 1), siteId)).status,
    ).toBe(409);
    expect(
      (await createPublishOperation(request("new-stale"), siteId)).status,
    ).toBe(409);
    expect(
      (await createPublishOperation(request("next", 1), siteId)).status,
    ).toBe(201);
    const state = await pool.query(
      'SELECT "desiredRevision", "desiredReleaseId" FROM "Site" WHERE "id" = $1',
      [siteId],
    );
    expect(state.rows[0]).toMatchObject({
      desiredRevision: 2,
      desiredReleaseId: releaseId,
    });
  });

  it("creates one operation for concurrent requests sharing a key", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        createPublishOperation(request("parallel", 2), siteId),
      ),
    );
    expect(results.map((result) => result.status).sort()).toEqual([
      200, 200, 200, 200, 201,
    ]);
    const bodies = await Promise.all(results.map((result) => result.json()));
    expect(new Set(bodies.map((body) => body.id)).size).toBe(1);
    expect(
      (
        await pool.query(
          'SELECT "desiredRevision" FROM "Site" WHERE "id" = $1',
          [siteId],
        )
      ).rows[0].desiredRevision,
    ).toBe(3);
  });

  it("claims distinct operations concurrently and reclaims an expired lease after restart", async () => {
    const claims = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        claimPublishOperation(pool, `worker-${i}`, 60),
      ),
    );
    const claimed = claims.filter((result) => result !== null);
    expect(claimed).toHaveLength(1);
    expect(new Set(claimed.map((result) => result.id)).size).toBe(1);
    expect(await claimPublishOperation(pool, "worker-extra", 60)).toBeNull();
    await pool.query(
      'UPDATE "PublishOperation" SET "leaseUntil" = now() - interval \'1 second\' WHERE "id" = $1',
      [claimed[0].id],
    );
    await pool.query(
      'UPDATE "Site" SET "lastPublishStartedAt" = now() - interval \'10 seconds\' WHERE "id" = $1',
      [siteId],
    );
    const recovered = await claimPublishOperation(pool, "restarted-worker", 60);
    expect(recovered?.id).toBe(claimed[0].id);
    expect(recovered?.leaseOwner).toBe("restarted-worker");
    expect(recovered?.attempts).toBe(2);
  });

  it("enforces the site pending quota atomically and returns Retry-After", async () => {
    const quotaWorkspace = randomUUID();
    const quotaSite = randomUUID();
    const originalWorkspace = process.env.CMS_WORKSPACE_ID;
    process.env.CMS_WORKSPACE_ID = quotaWorkspace;
    try {
      await pool.query(
        'INSERT INTO "Workspace" ("id","name","updatedAt") VALUES ($1,$2,now())',
        [quotaWorkspace, "quota"],
      );
      await pool.query(
        'INSERT INTO "Site" ("id","workspaceId","updatedAt") VALUES ($1,$2,now())',
        [quotaSite, quotaWorkspace],
      );
      await pool.query(
        'INSERT INTO "Release" ("id","siteId","releaseId","checksum","metadata") VALUES ($1,$2,$3,$4,$5::jsonb)',
        [randomUUID(), quotaSite, "quota-release", "sha256:test", "{}"],
      );
      for (let index = 0; index < 19; index += 1) {
        await pool.query(
          `INSERT INTO "PublishOperation"
          ("id","workspaceId","siteId","idempotencyKey","releaseId","expectedRevision","desiredRevision","updatedAt")
          VALUES ($1,$2,$3,$4,$5,0,0,now())`,
          [
            randomUUID(),
            quotaWorkspace,
            quotaSite,
            `seed-${index}`,
            "quota-release",
          ],
        );
      }
      const request = (key: string) =>
        new Request(
          `http://localhost/api/v1/sites/${quotaSite}/publish-operations`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer publish-secret",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              releaseId: "quota-release",
              idempotencyKey: key,
              expectedRevision: 0,
            }),
          },
        );
      const results = await Promise.all(
        Array.from({ length: 30 }, (_, index) =>
          createPublishOperation(request(`quota-${index}`), quotaSite),
        ),
      );
      expect(results.filter((result) => result.status === 201)).toHaveLength(1);
      const limited = results.filter((result) => result.status === 429);
      expect(limited).toHaveLength(29);
      expect(
        limited.every((result) => result.headers.get("retry-after") === "5"),
      ).toBe(true);
      expect((await limited[0].json()).error).toBe("publish_quota_exceeded");
      expect(
        (
          await pool.query(
            'SELECT COUNT(*)::int AS count FROM "PublishOperation" WHERE "siteId"=$1',
            [quotaSite],
          )
        ).rows[0].count,
      ).toBe(20);
    } finally {
      process.env.CMS_WORKSPACE_ID = originalWorkspace;
      await pool.query(
        'DELETE FROM "PublishOperation" WHERE "workspaceId"=$1',
        [quotaWorkspace],
      );
      await pool.query('DELETE FROM "Publication" WHERE "siteId"=$1', [
        quotaSite,
      ]);
      await pool.query('DELETE FROM "Release" WHERE "siteId"=$1', [quotaSite]);
      await pool.query('DELETE FROM "Site" WHERE "id"=$1', [quotaSite]);
      await pool.query('DELETE FROM "Workspace" WHERE "id"=$1', [
        quotaWorkspace,
      ]);
    }
  });

  it("enforces the workspace pending quota across sites", async () => {
    const quotaWorkspace = randomUUID();
    const quotaSites = Array.from({ length: 6 }, () => randomUUID());
    const originalWorkspace = process.env.CMS_WORKSPACE_ID;
    process.env.CMS_WORKSPACE_ID = quotaWorkspace;
    try {
      await pool.query(
        'INSERT INTO "Workspace" ("id","name","updatedAt") VALUES ($1,$2,now())',
        [quotaWorkspace, "workspace-quota"],
      );
      await pool.query(
        `INSERT INTO "Site" ("id","workspaceId","updatedAt")
        SELECT id,$2,now() FROM unnest($1::uuid[]) AS id`,
        [quotaSites, quotaWorkspace],
      );
      for (let siteIndex = 0; siteIndex < 5; siteIndex += 1) {
        const site = quotaSites[siteIndex];
        await pool.query(
          'INSERT INTO "Release" ("id","siteId","releaseId","checksum","metadata") VALUES ($1,$2,$3,$4,$5::jsonb)',
          [randomUUID(), site, "workspace-quota-release", "sha256:test", "{}"],
        );
        for (let index = 0; index < 20; index += 1) {
          await pool.query(
            `INSERT INTO "PublishOperation"
            ("id","workspaceId","siteId","idempotencyKey","releaseId","expectedRevision","desiredRevision","updatedAt")
            VALUES ($1,$2,$3,$4,$5,0,0,now())`,
            [
              randomUUID(),
              quotaWorkspace,
              site,
              `workspace-seed-${siteIndex}-${index}`,
              "workspace-quota-release",
            ],
          );
        }
      }
      const lastSite = quotaSites[5];
      await pool.query(
        'INSERT INTO "Release" ("id","siteId","releaseId","checksum","metadata") VALUES ($1,$2,$3,$4,$5::jsonb)',
        [
          randomUUID(),
          lastSite,
          "workspace-quota-release",
          "sha256:test",
          "{}",
        ],
      );
      const response = await createPublishOperation(
        new Request(
          `http://localhost/api/v1/sites/${lastSite}/publish-operations`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer publish-secret",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              releaseId: "workspace-quota-release",
              idempotencyKey: "workspace-limit",
              expectedRevision: 0,
            }),
          },
        ),
        lastSite,
      );
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("5");
      expect(await response.json()).toMatchObject({
        error: "publish_quota_exceeded",
        scope: "workspace",
      });
    } finally {
      process.env.CMS_WORKSPACE_ID = originalWorkspace;
      await pool.query(
        'DELETE FROM "Publication" WHERE "siteId" = ANY($1::uuid[])',
        [quotaSites],
      );
      await pool.query(
        'DELETE FROM "PublishOperation" WHERE "workspaceId"=$1',
        [quotaWorkspace],
      );
      await pool.query('DELETE FROM "Release" WHERE "siteId"=ANY($1::uuid[])', [
        quotaSites,
      ]);
      await pool.query('DELETE FROM "Site" WHERE "id"=ANY($1::uuid[])', [
        quotaSites,
      ]);
      await pool.query('DELETE FROM "Workspace" WHERE "id"=$1', [
        quotaWorkspace,
      ]);
    }
  });
});
