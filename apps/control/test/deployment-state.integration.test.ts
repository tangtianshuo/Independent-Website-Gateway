import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { finalizeAfterRouteVerification } from '../../../packages/worker/src/operations';
import { readPublicationState } from '../src/publication-state';
import { readDomainState } from '../src/domains';

const connectionString = process.env.GATEWAY_TEST_DATABASE_URL;
(connectionString ? describe : describe.skip)('current deployment identity PostgreSQL integration', () => {
  const pool = new Pool({ connectionString });
  const workspaceId = randomUUID(), siteId = randomUUID();
  const firstDigest = `sha256:${'a'.repeat(64)}`, secondDigest = `sha256:${'b'.repeat(64)}`;
  let directory: string;
  beforeAll(async () => {
    vi.stubEnv('CMS_SERVICE_SECRET', 'deployment-state-secret'); vi.stubEnv('CMS_WORKSPACE_ID', workspaceId);
    directory = await mkdtemp(join(tmpdir(), 'deployment-state-'));
    await pool.query('INSERT INTO "Workspace" ("id","name","updatedAt") VALUES ($1,$2,now())', [workspaceId, 'deployment state']);
    await pool.query('INSERT INTO "Site" ("id","workspaceId","updatedAt") VALUES ($1,$2,now())', [siteId, workspaceId]);
    await pool.query('INSERT INTO "TemplatePin" ("id","siteId","templateId","version","imageDigest","updatedAt") VALUES ($1,$2,$3,$4,$5,now())', [randomUUID(), siteId, 'aeroframe', '1.0.0', firstDigest]);
    for (const [releaseId, imageDigest] of [['first', firstDigest], ['second', secondDigest]]) {
      const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, workspaceId, siteId, title: releaseId }));
      const path = join(directory, releaseId); await writeFile(path, bytes);
      await pool.query('INSERT INTO "Release" ("id","siteId","releaseId","checksum","metadata","snapshotRef") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [randomUUID(), siteId, releaseId, `sha256:${createHash('sha256').update(bytes).digest('hex')}`, JSON.stringify({ templateId: 'aeroframe', templateVersion: '1.0.0', imageDigest }), path]);
    }
  });
  afterAll(async () => {
    for (const table of ['ActiveDeployment', 'Deployment', 'Publication', 'ReleaseArtifact', 'PublishOperation', 'Release', 'TemplatePin']) await pool.query(`DELETE FROM "${table}" WHERE "siteId"=$1`, [siteId]);
    await pool.query('DELETE FROM "Site" WHERE "id"=$1', [siteId]); await pool.query('DELETE FROM "Workspace" WHERE "id"=$1', [workspaceId]);
    await pool.end(); if (directory) await rm(directory, { recursive: true, force: true }); vi.unstubAllEnvs();
  });
  async function publish(releaseId: string, imageDigest: string, revision: number, host: string, credential = true) {
    const id = randomUUID();
    await pool.query('UPDATE "TemplatePin" SET "imageDigest"=$1 WHERE "siteId"=$2', [imageDigest, siteId]);
    await pool.query('UPDATE "Site" SET "desiredReleaseId"=$1,"desiredRevision"=$2 WHERE "id"=$3', [releaseId, revision, siteId]);
    await pool.query(`INSERT INTO "PublishOperation" ("id","workspaceId","siteId","idempotencyKey","releaseId","expectedRevision","desiredRevision","leaseOwner","leaseUntil","attempts","candidateCredentialHash","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '1 minute',1,$9,now())`, [id, workspaceId, siteId, randomUUID(), releaseId, revision - 1, revision, 'state-worker', credential ? 'c'.repeat(64) : null]);
    const row = await pool.query('SELECT "leaseUntil" FROM "PublishOperation" WHERE "id"=$1', [id]);
    const result = await finalizeAfterRouteVerification(pool, { operationId: id, workerId: 'state-worker', attempts: 1, leaseUntil: row.rows[0].leaseUntil, imageDigest, host });
    return { id, result };
  }
  async function assertState(releaseId: string, digest: string, revision: number, host: string, id: string) {
    const req = new Request('http://localhost/state', { headers: { authorization: 'Bearer deployment-state-secret' } });
    const publication = await readPublicationState(req, siteId, pool);
    expect(publication.status).toBe(200);
    const state = await publication.json(); expect(state.active).toMatchObject({ releaseId, imageDigest: digest, routeRevision: revision, snapshot: { title: releaseId } });
    const domains = await readDomainState(req, siteId, pool); expect(domains.status).toBe(200);
    expect((await domains.json()).route).toMatchObject({ releaseId, revision, host, health: 'healthy' });
    const active = await pool.query('SELECT active."id",deployment."releaseId",deployment."activatedAt" FROM "ActiveDeployment" active JOIN "Deployment" deployment ON deployment."id"=active."id" WHERE active."siteId"=$1', [siteId]);
    expect(active.rows[0]).toMatchObject({ id, releaseId }); expect(state.active.createdAt).toBe(active.rows[0].activatedAt.toISOString());
  }
  it('reports the second published deployment and preserves history when rolling back to the first release', async () => {
    const first = await publish('first', firstDigest, 1, 'old.example.test'); expect(first.result).toBe(true);
    await assertState('first', firstDigest, 1, 'old.example.test', first.id);
    const second = await publish('second', secondDigest, 2, 'new.example.test'); expect(second.result).toBe(true);
    await assertState('second', secondDigest, 2, 'new.example.test', second.id);
    const rollback = await publish('first', firstDigest, 3, 'rollback.example.test'); expect(rollback.result).toBe(true);
    await assertState('first', firstDigest, 3, 'rollback.example.test', rollback.id);
    const failed = await publish('second', secondDigest, 4, 'failed.example.test', false); expect(failed.result).toBe(false);
    await assertState('first', firstDigest, 3, 'rollback.example.test', rollback.id);
    expect((await pool.query('SELECT "id" FROM "Deployment" WHERE "siteId"=$1', [siteId])).rows).toHaveLength(3);
  });
});
