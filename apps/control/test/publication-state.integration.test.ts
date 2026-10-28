import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readPublicationState } from '../src/publication-state';

const connectionString = process.env.GATEWAY_TEST_DATABASE_URL;
const run = connectionString ? describe : describe.skip;

run('publication state database integration', () => {
  const pool = new Pool({ connectionString });
  const workspaceId = randomUUID();
  const foreignWorkspaceId = randomUUID();
  const siteId = randomUUID();
  const foreignSiteId = randomUUID();
  const imageDigest = `sha256:${'a'.repeat(64)}`;
  const snapshot = { schemaVersion: 1, workspaceId, siteId, title: 'Immutable active release' };
  const bytes = Buffer.from(JSON.stringify(snapshot));
  let directory: string;
  let path: string;
  const request = (id = siteId) => new Request(`http://localhost/api/v1/sites/${id}/publication-state`, {
    headers: { authorization: 'Bearer publication-integration-secret' },
  });

  beforeAll(async () => {
    vi.stubEnv('CMS_SERVICE_SECRET', 'publication-integration-secret');
    vi.stubEnv('CMS_WORKSPACE_ID', workspaceId);
    directory = await mkdtemp(join(tmpdir(), 'publication-state-integration-'));
    path = join(directory, 'snapshot');
    await writeFile(path, bytes);
    await pool.query('INSERT INTO "Workspace" ("id", "name", "updatedAt") VALUES ($1, $3, now()), ($2, $3, now())', [workspaceId, foreignWorkspaceId, 'publication state test']);
    await pool.query('INSERT INTO "Site" ("id", "workspaceId", "desiredRevision", "desiredReleaseId", "updatedAt") VALUES ($1,$2,9,$3,now()),($4,$5,0,NULL,now())', [siteId, workspaceId, 'pending-release', foreignSiteId, foreignWorkspaceId]);
    await pool.query('INSERT INTO "Release" ("id","siteId","releaseId","checksum","metadata","snapshotRef") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [randomUUID(), siteId, 'active-release', `sha256:${createHash('sha256').update(bytes).digest('hex')}`, JSON.stringify({ imageDigest, templateId: 'aeroframe', checksum: 'internal-only' }), path]);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await pool.query('DELETE FROM "ActiveDeployment" WHERE "siteId" = $1', [siteId]);
    await pool.query('DELETE FROM "Release" WHERE "siteId" = $1', [siteId]);
    await pool.query('DELETE FROM "Site" WHERE "id" IN ($1,$2)', [siteId, foreignSiteId]);
    await pool.query('DELETE FROM "Workspace" WHERE "id" IN ($1,$2)', [workspaceId, foreignWorkspaceId]);
    await pool.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  it('scopes the query to the authenticated workspace', async () => {
    const response = await readPublicationState(request(foreignSiteId), foreignSiteId, pool);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'site_not_found' });
  });
  it('returns no active state for an unactivated release', async () => {
    const response = await readPublicationState(request(), siteId, pool);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revision: 9, active: null });
  });
  it('joins the active release rather than the newer desired release', async () => {
    await pool.query('INSERT INTO "ActiveDeployment" ("id","siteId","releaseId","imageDigest","routeRevision") VALUES ($1,$2,$3,$4,7)', [randomUUID(), siteId, 'active-release', imageDigest]);
    const response = await readPublicationState(request(), siteId, pool);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revision: 9, active: {
      releaseId: 'active-release', imageDigest, routeRevision: 7, metadata: { imageDigest, templateId: 'aeroframe' },
      snapshot, createdAt: expect.any(String),
    } });
  });
  it('fails closed on changed immutable bytes', async () => {
    await writeFile(path, JSON.stringify({ ...snapshot, title: 'Tampered' }));
    const response = await readPublicationState(request(), siteId, pool);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'publication_state_unavailable' });
  });
});
