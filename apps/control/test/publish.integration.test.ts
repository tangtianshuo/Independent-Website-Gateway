import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimPublishOperation } from '../../../packages/worker/src/claim';
import type { createPublishOperation as PublishHandler } from '../src/publish';

const connectionString = process.env.GATEWAY_TEST_DATABASE_URL;
const run = connectionString ? describe : describe.skip;

run('publish PostgreSQL integration', () => {
  const pool = new Pool({ connectionString });
  const workspaceId = randomUUID();
  const foreignWorkspaceId = randomUUID();
  const siteId = randomUUID();
  const foreignSiteId = randomUUID();
  const releaseId = 'release-one';
  let createPublishOperation: typeof PublishHandler;

  function request(key: string, expectedRevision = 0, id: string = siteId, body: Record<string, unknown> = {}) {
    return new Request(`http://localhost/api/v1/sites/${id}/publish-operations`, {
      method: 'POST',
      headers: { authorization: 'Bearer publish-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ releaseId, idempotencyKey: key, expectedRevision, ...body }),
    });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = connectionString;
    ({ createPublishOperation } = await import('../src/publish'));
    process.env.CMS_SERVICE_SECRET = 'publish-secret';
    process.env.CMS_WORKSPACE_ID = workspaceId;
    await pool.query('INSERT INTO "Workspace" ("id", "name", "updatedAt") VALUES ($1, $2, now()), ($3, $4, now())', [workspaceId, 'owner', foreignWorkspaceId, 'other']);
    await pool.query('INSERT INTO "Site" ("id", "workspaceId", "updatedAt") VALUES ($1, $2, now()), ($3, $4, now())', [siteId, workspaceId, foreignSiteId, foreignWorkspaceId]);
    await pool.query('INSERT INTO "Release" ("id", "siteId", "releaseId", "checksum", "metadata") VALUES ($1, $2, $3, $4, $5::jsonb)', [randomUUID(), siteId, releaseId, 'sha256:test', '{}']);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM "PublishOperation" WHERE "siteId" IN ($1, $2)', [siteId, foreignSiteId]);
    await pool.query('DELETE FROM "Release" WHERE "siteId" = $1', [siteId]);
    await pool.query('DELETE FROM "Site" WHERE "id" IN ($1, $2)', [siteId, foreignSiteId]);
    await pool.query('DELETE FROM "Workspace" WHERE "id" IN ($1, $2)', [workspaceId, foreignWorkspaceId]);
    await pool.end();
  });

  it('rejects unauthenticated, empty-secret and malformed site requests without a database error', async () => {
    expect((await createPublishOperation(new Request('http://localhost', { method: 'POST' }), siteId)).status).toBe(401);
    const original = process.env.CMS_SERVICE_SECRET;
    process.env.CMS_SERVICE_SECRET = '';
    try {
      expect((await createPublishOperation(new Request('http://localhost', { method: 'POST', headers: { authorization: 'Bearer ' } }), siteId)).status).toBe(401);
    } finally {
      process.env.CMS_SERVICE_SECRET = original;
    }
    expect((await createPublishOperation(request('bad-id', 0, 'not-a-uuid'), 'not-a-uuid')).status).toBe(400);
  });

  it('does not accept a foreign site or a release absent from the owned site', async () => {
    expect((await createPublishOperation(request('foreign', 0, foreignSiteId), foreignSiteId)).status).toBe(404);
    expect((await createPublishOperation(request('missing', 0, siteId, { releaseId: 'unknown' }), siteId)).status).toBe(404);
  });

  it('replays the original operation for the same payload, rejects changed payload and stale revision', async () => {
    const first = await createPublishOperation(request('repeat'), siteId);
    expect(first.status).toBe(201);
    const operation = await first.json();
    expect(operation).toMatchObject({ releaseId, expectedRevision: 0, desiredRevision: 1, status: 'pending' });
    await expect((await createPublishOperation(request('repeat'), siteId)).json()).resolves.toMatchObject({ id: operation.id });
    expect((await createPublishOperation(request('repeat', 1), siteId)).status).toBe(409);
    expect((await createPublishOperation(request('new-stale'), siteId)).status).toBe(409);
    expect((await createPublishOperation(request('next', 1), siteId)).status).toBe(201);
    const state = await pool.query('SELECT "desiredRevision", "desiredReleaseId" FROM "Site" WHERE "id" = $1', [siteId]);
    expect(state.rows[0]).toMatchObject({ desiredRevision: 2, desiredReleaseId: releaseId });
  });

  it('creates one operation for concurrent requests sharing a key', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => createPublishOperation(request('parallel', 2), siteId)));
    expect(results.map(result => result.status).sort()).toEqual([200, 200, 200, 200, 201]);
    const bodies = await Promise.all(results.map(result => result.json()));
    expect(new Set(bodies.map(body => body.id)).size).toBe(1);
    expect((await pool.query('SELECT "desiredRevision" FROM "Site" WHERE "id" = $1', [siteId])).rows[0].desiredRevision).toBe(3);
  });

  it('claims distinct operations concurrently and reclaims an expired lease after restart', async () => {
    const claims = await Promise.all(Array.from({ length: 4 }, (_, i) => claimPublishOperation(pool, `worker-${i}`, 60)));
    const claimed = claims.filter(result => result !== null);
    expect(claimed).toHaveLength(3);
    expect(new Set(claimed.map(result => result.id)).size).toBe(3);
    expect((await claimPublishOperation(pool, 'worker-extra', 60))).toBeNull();
    await pool.query('UPDATE "PublishOperation" SET "leaseUntil" = now() - interval \'1 second\' WHERE "id" = $1', [claimed[0].id]);
    const recovered = await claimPublishOperation(pool, 'restarted-worker', 60);
    expect(recovered?.id).toBe(claimed[0].id);
    expect(recovered?.leaseOwner).toBe('restarted-worker');
    expect(recovered?.attempts).toBe(2);
  });
});
