import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { claimPublishOperation } from './claim.js';
import { failPublishOperation, finalizeAfterRouteVerification, persistCandidateCredential } from './operations.js';

const connectionString = process.env.GATEWAY_TEST_DATABASE_URL;
const pool = connectionString ? new Pool({ connectionString }) : null;
const workspaceId = randomUUID();
const siteId = randomUUID();
const otherSiteId = randomUUID();
const digest = `sha256:${'a'.repeat(64)}`;
const otherDigest = `sha256:${'b'.repeat(64)}`;

before(async () => {
  if (!pool) return;
  await pool.query('INSERT INTO "Workspace" ("id", "name", "updatedAt") VALUES ($1, $2, now())', [workspaceId, 'test']);
  await pool.query('INSERT INTO "Site" ("id", "workspaceId", "updatedAt") VALUES ($1, $3, now()), ($2, $3, now())', [siteId, otherSiteId, workspaceId]);
  await pool.query('INSERT INTO "TemplatePin" ("id", "siteId", "templateId", "version", "imageDigest", "updatedAt") VALUES ($1, $2, $3, $4, $5, now())', [randomUUID(), siteId, 'storefront', '1.0', digest]);
});

after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM "ActiveDeployment" WHERE "siteId" IN ($1, $2)', [siteId, otherSiteId]);
  await pool.query('DELETE FROM "PublishOperation" WHERE "siteId" IN ($1, $2)', [siteId, otherSiteId]);
  await pool.query('DELETE FROM "Release" WHERE "siteId" IN ($1, $2)', [siteId, otherSiteId]);
  await pool.query('DELETE FROM "TemplatePin" WHERE "siteId" IN ($1, $2)', [siteId, otherSiteId]);
  await pool.query('DELETE FROM "Site" WHERE "id" IN ($1, $2)', [siteId, otherSiteId]);
  await pool.query('DELETE FROM "Workspace" WHERE "id" = $1', [workspaceId]);
  await pool.end();
});

async function release(id: string, owner = siteId, imageDigest = digest, templateId = 'storefront', templateVersion = '1.0') {
  await pool!.query('INSERT INTO "Release" ("id", "siteId", "releaseId", "checksum", "metadata", "snapshotRef") VALUES ($1, $2, $3, $4, $5::jsonb, $6)',
    [randomUUID(), owner, id, 'sha256:test', JSON.stringify({ imageDigest, templateId, templateVersion }), '/test/snapshot']);
}

async function operation(id: string, revision: number, owner = siteId) {
  const operationId = randomUUID();
  await pool!.query('UPDATE "Site" SET "desiredRevision" = $1, "desiredReleaseId" = $2 WHERE "id" = $3', [revision, id, owner]);
  await pool!.query('INSERT INTO "PublishOperation" ("id", "workspaceId", "siteId", "idempotencyKey", "releaseId", "expectedRevision", "desiredRevision", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, now())',
    [operationId, workspaceId, owner, randomUUID(), id, revision - 1, revision]);
  const claimed = await claimPublishOperation(pool!, 'worker-a', 60);
  assert.equal(claimed?.id, operationId);
  return claimed!;
}

async function active() {
  const result = await pool!.query('SELECT "releaseId", "imageDigest", "routeRevision" FROM "ActiveDeployment" WHERE "siteId" = $1', [siteId]);
  return result.rows[0] ?? null;
}

type Claim = NonNullable<Awaited<ReturnType<typeof claimPublishOperation>>>;

async function credential(claim: Claim, secret = 'a'.repeat(64)) {
  return persistCandidateCredential(pool!, { operationId: claim.id, workerId: claim.leaseOwner,
    attempts: claim.attempts, leaseUntil: claim.leaseUntil, credential: secret });
}

function finalize(claim: Claim, imageDigest = digest) {
  return finalizeAfterRouteVerification(pool!, { operationId: claim.id, workerId: claim.leaseOwner, attempts: claim.attempts, leaseUntil: claim.leaseUntil, imageDigest });
}

function fail(claim: Claim) {
  return failPublishOperation(pool!, { operationId: claim.id, workerId: claim.leaseOwner, attempts: claim.attempts, leaseUntil: claim.leaseUntil, failureCode: 'CANDIDATE_UNHEALTHY' });
}

test('finalizes ready and the active tuple together after route verification', { skip: !pool }, async () => {
  await release('first');
  const claim = await operation('first', 1);
  assert.equal(await finalize(claim), false);
  assert.equal(await credential(claim), true);
  assert.equal(await finalize(claim), true);
  const site = await pool!.query('SELECT "credentialHash" FROM "Site" WHERE "id" = $1', [siteId]);
  assert.match(site.rows[0].credentialHash, /^[a-f0-9]{64}$/);
  assert.notEqual(site.rows[0].credentialHash, 'a'.repeat(64));
  assert.deepEqual(await active(), { releaseId: 'first', imageDigest: digest, routeRevision: 1 });
  const status = await pool!.query('SELECT "status", "leaseOwner", "leaseUntil", "failureCode" FROM "PublishOperation" WHERE "id" = $1', [claim.id]);
  assert.deepEqual(status.rows[0], { status: 'ready', leaseOwner: null, leaseUntil: null, failureCode: null });
});

test('rejects an expired or superseded lease even with the same worker ID', { skip: !pool }, async () => {
  await release('expired');
  const claim = await operation('expired', 2);
  await pool!.query('UPDATE "PublishOperation" SET "leaseUntil" = now() - interval \'1 second\' WHERE "id" = $1', [claim.id]);
  assert.equal(await finalize(claim), false);
  const reclaimed = await claimPublishOperation(pool!, 'worker-a', 60);
  assert.equal(reclaimed?.id, claim.id);
  assert.equal(await finalize(claim), false);
  assert.deepEqual(await active(), { releaseId: 'first', imageDigest: digest, routeRevision: 1 });
  assert.equal(await credential(reclaimed!), true);
  assert.equal(await finalize(reclaimed!), true);
});

test('rejects another worker and a stale desired revision without changing the old tuple', { skip: !pool }, async () => {
  await release('stale');
  const claim = await operation('stale', 3);
  assert.equal(await finalizeAfterRouteVerification(pool!, { ...claim, operationId: claim.id, workerId: 'worker-b', imageDigest: digest }), false);
  await pool!.query('UPDATE "Site" SET "desiredRevision" = 4 WHERE "id" = $1', [siteId]);
  assert.equal(await finalize(claim), false);
  assert.deepEqual(await active(), { releaseId: 'expired', imageDigest: digest, routeRevision: 2 });
});

test('rejects a foreign Release, a mismatched digest, and an unpinned image while preserving the old tuple', { skip: !pool }, async () => {
  await release('foreign', otherSiteId);
  const foreign = await operation('foreign', 5);
  assert.equal(await finalize(foreign), false);
  await release('wrong-image', siteId, otherDigest);
  const wrong = await operation('wrong-image', 6);
  assert.equal(await finalize(wrong), false);
  await release('untrusted', siteId, digest, 'unknown');
  const untrusted = await operation('untrusted', 7);
  assert.equal(await finalize(untrusted), false);
  assert.deepEqual(await active(), { releaseId: 'expired', imageDigest: digest, routeRevision: 2 });
  const statuses = await pool!.query('SELECT "status" FROM "PublishOperation" WHERE "id" = ANY($1::uuid[])', [[foreign.id, wrong.id, untrusted.id]]);
  assert.ok(statuses.rows.every(row => row.status === 'pending'));
});

test('concurrent finalize calls have only one winner', { skip: !pool }, async () => {
  await release('parallel');
  const claim = await operation('parallel', 8);
  assert.equal(await credential(claim), true);
  assert.deepEqual((await Promise.all([finalize(claim), finalize(claim)])).sort(), [false, true]);
  assert.deepEqual(await active(), { releaseId: 'parallel', imageDigest: digest, routeRevision: 8 });
});

test('release and pin changes and pin inserts wait until finalize commits', { skip: !pool }, async () => {
  for (const [target, revision] of [['Release', 9], ['TemplatePin', 10], ['new TemplatePin', 11]] as const) {
    const id = `locked-${target}`;
    await release(id);
    const claim = await operation(id, revision);
    assert.equal(await credential(claim), true);
    const blocker = await pool!.connect();
    let finishing: Promise<boolean> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM "ActiveDeployment" WHERE "siteId" = $1 FOR UPDATE', [siteId]);
      finishing = finalize(claim);
      const deadline = Date.now() + 5000;
      while (true) {
        const waiting = await pool!.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%INSERT INTO "ActiveDeployment"%' AND pid <> pg_backend_pid()`);
        if (waiting.rowCount) break;
        assert.ok(Date.now() < deadline, 'finalize did not reach the deployment write');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const writer = await pool!.connect();
      try {
        await writer.query('BEGIN');
        await writer.query("SET LOCAL lock_timeout = '200ms'");
        const change = target === 'Release'
          ? writer.query('UPDATE "Release" SET "snapshotRef" = NULL WHERE "siteId" = $1 AND "releaseId" = $2', [siteId, id])
          : target === 'TemplatePin'
            ? writer.query('UPDATE "TemplatePin" SET "imageDigest" = $1 WHERE "siteId" = $2 AND "templateId" = $3', [otherDigest, siteId, 'storefront'])
            : writer.query('INSERT INTO "TemplatePin" ("id", "siteId", "templateId", "version", "imageDigest", "updatedAt") VALUES ($1, $2, $3, $4, $5, now())', [randomUUID(), siteId, 'new-template', '1.0', digest]);
        await assert.rejects(change, { code: '55P03' });
      } finally {
        await writer.query('ROLLBACK');
        writer.release();
      }
    } finally {
      await blocker.query('COMMIT');
      blocker.release();
      if (finishing) assert.equal(await finishing, true);
    }
  }
});

test('expired failure and late failure from the same worker cannot invalidate a reclaimed attempt', { skip: !pool }, async () => {
  await release('reclaimed-failure');
  const claim = await operation('reclaimed-failure', 9);
  await pool!.query('UPDATE "PublishOperation" SET "leaseUntil" = now() - interval \'1 second\' WHERE "id" = $1', [claim.id]);
  assert.equal(await fail(claim), false);
  const reclaimed = await claimPublishOperation(pool!, 'worker-a', 60);
  assert.equal(reclaimed?.id, claim.id);
  assert.equal(await fail(claim), false);
  const status = await pool!.query('SELECT "status", "attempts", "leaseOwner" FROM "PublishOperation" WHERE "id" = $1', [claim.id]);
  assert.deepEqual(status.rows[0], { status: 'pending', attempts: reclaimed!.attempts, leaseOwner: 'worker-a' });
  assert.equal(await fail(reclaimed!), true);
});

test('candidate failure leaves the prior active tuple untouched and cannot finalize', { skip: !pool }, async () => {
  await release('failed-candidate');
  const claim = await operation('failed-candidate', 9);
  assert.equal(await fail(claim), true);
  assert.equal(await finalize(claim), false);
  assert.deepEqual(await active(), { releaseId: 'locked-new TemplatePin', imageDigest: digest, routeRevision: 11 });
  const status = await pool!.query('SELECT "status", "failureCode" FROM "PublishOperation" WHERE "id" = $1', [claim.id]);
  assert.deepEqual(status.rows[0], { status: 'failed', failureCode: 'CANDIDATE_UNHEALTHY' });
});

test('public finalization rejects every changed or NULL pin field and preserves the active release', { skip: !pool }, async () => {
  const publicSite = randomUUID();
  const publicOperation = randomUUID();
  const repository = 'ghcr.io/tangtianshuo/independent-website-templates/aeroframe';
  const manifestChecksum = `sha256:${'c'.repeat(64)}`;
  const sourceCommit = 'd'.repeat(40);
  const oldCredential = 'old-credential-hash';
  await pool!.query('INSERT INTO "Site" ("id","workspaceId","desiredRevision","desiredReleaseId","credentialHash","updatedAt") VALUES ($1,$2,1,$3,$4,now())', [publicSite, workspaceId, 'public-release', oldCredential]);
  await pool!.query('INSERT INTO "TemplatePin" ("id","siteId","templateId","version","imageDigest","imageRepository","manifestChecksum","sourceCommit","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())', [randomUUID(), publicSite, 'aeroframe', '1.0.1', digest, repository, manifestChecksum, sourceCommit]);
  await pool!.query('INSERT INTO "Release" ("id","siteId","releaseId","checksum","metadata","snapshotRef") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [randomUUID(), publicSite, 'public-release', 'sha256:test', JSON.stringify({ templateId: 'aeroframe', templateVersion: '1.0.1', imageDigest: digest, manifestChecksum }), '/test/public-snapshot']);
  await pool!.query('INSERT INTO "ActiveDeployment" ("id","siteId","releaseId","imageDigest","routeRevision") VALUES ($1,$2,$3,$4,0)', [randomUUID(), publicSite, 'old-public-release', otherDigest]);
  await pool!.query('INSERT INTO "PublishOperation" ("id","workspaceId","siteId","idempotencyKey","releaseId","expectedRevision","desiredRevision","leaseOwner","leaseUntil","attempts","candidateCredentialHash","updatedAt") VALUES ($1,$2,$3,$4,$5,0,1,$6,now()+interval \'1 minute\',1,$7,now())', [publicOperation, workspaceId, publicSite, randomUUID(), 'public-release', 'public-worker', 'e'.repeat(64)]);
  const saved = await pool!.query('SELECT "leaseUntil" FROM "PublishOperation" WHERE "id"=$1', [publicOperation]);
  const input = { operationId: publicOperation, workerId: 'public-worker', attempts: 1, leaseUntil: saved.rows[0].leaseUntil, imageDigest: digest, imageRepository: repository, sourceCommit, manifestChecksum };
  try {
    const variants = [
      [null, null, null], [null, manifestChecksum, sourceCommit], [repository, null, sourceCommit], [repository, manifestChecksum, null],
      [repository + '-other', manifestChecksum, sourceCommit], [repository, `sha256:${'f'.repeat(64)}`, sourceCommit], [repository, manifestChecksum, 'f'.repeat(40)],
    ];
    for (const [repo, checksum, commit] of variants) {
      await pool!.query('UPDATE "TemplatePin" SET "imageRepository"=$1,"manifestChecksum"=$2,"sourceCommit"=$3 WHERE "siteId"=$4', [repo, checksum, commit, publicSite]);
      assert.equal(await finalizeAfterRouteVerification(pool!, input), false, `public mismatch accepted: ${JSON.stringify([repo, checksum, commit])}`);
      const state = await pool!.query('SELECT "releaseId","routeRevision" FROM "ActiveDeployment" WHERE "siteId"=$1', [publicSite]);
      assert.deepEqual(state.rows[0], { releaseId: 'old-public-release', routeRevision: 0 });
      assert.equal((await pool!.query('SELECT "credentialHash" FROM "Site" WHERE "id"=$1', [publicSite])).rows[0].credentialHash, oldCredential);
    }
    await pool!.query('UPDATE "TemplatePin" SET "imageRepository"=$1,"manifestChecksum"=$2,"sourceCommit"=$3 WHERE "siteId"=$4', [repository, manifestChecksum, sourceCommit, publicSite]);
    assert.equal(await finalizeAfterRouteVerification(pool!, input), true);
    assert.equal((await pool!.query('SELECT "status" FROM "PublishOperation" WHERE "id"=$1', [publicOperation])).rows[0].status, 'ready');
    assert.equal((await pool!.query('SELECT "releaseId" FROM "ActiveDeployment" WHERE "siteId"=$1', [publicSite])).rows[0].releaseId, 'public-release');
  } finally {
    for (const table of ['ActiveDeployment', 'PublishOperation', 'Release', 'TemplatePin']) await pool!.query(`DELETE FROM "${table}" WHERE "siteId"=$1`, [publicSite]);
    await pool!.query('DELETE FROM "Site" WHERE "id"=$1', [publicSite]);
  }
});
