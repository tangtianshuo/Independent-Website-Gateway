import { createHash, randomUUID } from 'node:crypto';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { canonicalJson } from '@gateway/contracts';
import { readPublishedRelease } from '../src/published-release';

const connectionString = process.env.GATEWAY_TEST_DATABASE_URL;
const run = connectionString ? describe : describe.skip;

run('published release', () => {
  const pool = new Pool({ connectionString });
  const workspaceId = randomUUID();
  const siteId = randomUUID();
  const otherSiteId = randomUUID();
  const credential = randomUUID();
  const candidateCredential = randomUUID();
  const snapshot = { schemaVersion: 1, workspaceId, siteId, title: 'hello' };
  const bytes = Buffer.from(JSON.stringify(snapshot));
  let directory: string;
  let path: string;
  const request = (id: string = siteId, token: string = credential, releaseId?: string) => new Request(`http://localhost/api/v1/sites/${id}/published-release${releaseId ? `?releaseId=${releaseId}` : ''}`, { headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'published-release-'));
    path = join(directory, 'snapshot');
    await writeFile(path, bytes);
    await pool.query('INSERT INTO "Workspace" ("id", "name", "updatedAt") VALUES ($1, $2, now())', [workspaceId, 'test']);
    await pool.query('INSERT INTO "Site" ("id", "workspaceId", "credentialHash", "updatedAt") VALUES ($1,$3,$4,now()),($2,$3,$4,now())', [siteId, otherSiteId, workspaceId, createHash('sha256').update(credential).digest('hex')]);
    await pool.query('INSERT INTO "Release" ("id","siteId","releaseId","checksum","metadata","snapshotRef") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [randomUUID(), siteId, 'first', `sha256:${createHash('sha256').update(bytes).digest('hex')}`, '{}', path]);
  });
  afterAll(async () => {
    await pool.query('DELETE FROM "PublishOperation" WHERE "siteId" IN ($1,$2)', [siteId, otherSiteId]);
    await pool.query('DELETE FROM "ActiveDeployment" WHERE "siteId" IN ($1,$2)', [siteId, otherSiteId]);
    await pool.query('DELETE FROM "Release" WHERE "siteId" IN ($1,$2)', [siteId, otherSiteId]);
    await pool.query('DELETE FROM "Site" WHERE "id" IN ($1,$2)', [siteId, otherSiteId]);
    await pool.query('DELETE FROM "Workspace" WHERE "id" = $1', [workspaceId]);
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  });

  it('does not serve unactivated releases or another site', async () => {
    expect((await readPublishedRelease(request(), siteId, pool)).status).toBe(404);
    expect((await readPublishedRelease(request(otherSiteId), otherSiteId, pool)).status).toBe(404);
  });
  it('serves only active release with canonical checksum and rejects wrong bearer', async () => {
    await pool.query('INSERT INTO "ActiveDeployment" ("id","siteId","releaseId","imageDigest") VALUES ($1,$2,$3,$4)', [randomUUID(), siteId, 'first', `sha256:${'a'.repeat(64)}`]);
    expect((await readPublishedRelease(request(siteId, 'wrong'), siteId, pool)).status).toBe(401);
    const response = await readPublishedRelease(request(), siteId, pool);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ schemaVersion: 1, workspaceId, siteId, releaseId: 'first', checksum: createHash('sha256').update(canonicalJson(snapshot)).digest('hex'), snapshot });
  });
  it('serves an explicit active release only to its site credential', async () => {
    await pool.query('INSERT INTO "Release" ("id","siteId","releaseId","checksum","metadata","snapshotRef") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [randomUUID(), siteId, 'stale', `sha256:${createHash('sha256').update(bytes).digest('hex')}`, '{}', path]);
    const response = await readPublishedRelease(request(siteId, credential, 'first'), siteId, pool);
    expect(response.status).toBe(200);
    expect((await response.json()).releaseId).toBe('first');
    expect((await readPublishedRelease(request(siteId, credential, 'stale'), siteId, pool)).status).toBe(401);
    expect((await readPublishedRelease(request(otherSiteId, credential, 'first'), otherSiteId, pool)).status).toBe(401);
    expect((await readPublishedRelease(request(siteId, 'wrong', 'first'), siteId, pool)).status).toBe(401);
  });
  it('rejects mutated bytes and mismatched snapshot identity', async () => {
    await writeFile(path, JSON.stringify({ ...snapshot, siteId: otherSiteId }));
    expect((await readPublishedRelease(request(), siteId, pool)).status).toBe(503);
    await writeFile(path, bytes);
  });
  it('permits only lease-bound candidate token for its release', async () => {
    const operationId = randomUUID();
    await pool.query('INSERT INTO "PublishOperation" ("id","workspaceId","siteId","idempotencyKey","releaseId","expectedRevision","desiredRevision","leaseOwner","leaseUntil","attempts","candidateCredentialHash","updatedAt") VALUES ($1,$2,$3,$4,$5,0,1,$6,now()+interval \'1 minute\',1,$7,now())', [operationId, workspaceId, siteId, randomUUID(), 'stale', 'worker', createHash('sha256').update(candidateCredential).digest('hex')]);
    expect((await readPublishedRelease(request(siteId, candidateCredential, 'stale'), siteId, pool)).status).toBe(200);
    expect((await readPublishedRelease(request(siteId, candidateCredential), siteId, pool)).status).toBe(401);
    expect((await readPublishedRelease(request(siteId, credential, 'stale'), siteId, pool)).status).toBe(401);
    expect((await readPublishedRelease(request(siteId, candidateCredential, 'first'), siteId, pool)).status).toBe(401);
    expect((await readPublishedRelease(request(otherSiteId, candidateCredential, 'stale'), otherSiteId, pool)).status).toBe(401);
    await pool.query('UPDATE "PublishOperation" SET "leaseUntil" = now() - interval \'1 minute\' WHERE "id" = $1', [operationId]);
    expect((await readPublishedRelease(request(siteId, candidateCredential, 'stale'), siteId, pool)).status).toBe(401);
    await pool.query('UPDATE "PublishOperation" SET "status" = $2, "leaseUntil" = now() + interval \'1 minute\' WHERE "id" = $1', [operationId, 'ready']);
    expect((await readPublishedRelease(request(siteId, candidateCredential, 'stale'), siteId, pool)).status).toBe(401);
  });
});
