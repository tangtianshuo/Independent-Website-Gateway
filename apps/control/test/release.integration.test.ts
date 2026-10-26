import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const connectionString = process.env.GATEWAY_TEST_DATABASE_URL;
const run = connectionString ? describe : describe.skip;

run('Release PostgreSQL integration', () => {
  const pool = new Pool({ connectionString });
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const siteId = randomUUID();
  let directory: string;
  let receiveRelease: (request: Request, siteId: string) => Promise<Response>;
  const snapshot = Buffer.from('{"title":"First"}');
  const checksum = `sha256:${createHash('sha256').update(snapshot).digest('hex')}`;
  const metadata = {
    templateId: 'example',
    templateVersion: '1.0.0',
    manifestChecksum: `sha256:${'a'.repeat(64)}`,
    imageDigest: `sha256:${'b'.repeat(64)}`,
  };

  function request(releaseId: string, body: Record<string, unknown> = {}) {
    return new Request(`http://localhost/api/v1/sites/${siteId}/releases`, {
      method: 'POST',
      headers: { authorization: 'Bearer integration-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ siteId, releaseId, checksum, metadata, snapshot: snapshot.toString('base64'), ...body }),
    });
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'gateway-release-'));
    process.env.DATABASE_URL = connectionString;
    process.env.SNAPSHOT_STORAGE_PATH = directory;
    process.env.CMS_SERVICE_SECRET = 'integration-secret';
    process.env.CMS_WORKSPACE_ID = workspaceId;
    process.env.ALLOWED_TEMPLATE_IDS = 'example';
    ({ receiveRelease } = await import('../src/releases'));
    await pool.query('INSERT INTO "Workspace" ("id", "name", "updatedAt") VALUES ($1, $2, now()), ($3, $4, now())', [workspaceId, 'owner', otherWorkspaceId, 'other']);
    await pool.query('INSERT INTO "Site" ("id", "workspaceId", "updatedAt") VALUES ($1, $2, now())', [siteId, workspaceId]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM "Release" WHERE "siteId" = $1', [siteId]);
    await pool.query('DELETE FROM "Site" WHERE "id" = $1', [siteId]);
    await pool.query('DELETE FROM "Workspace" WHERE "id" IN ($1, $2)', [workspaceId, otherWorkspaceId]);
    await pool.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('rejects another workspace without storing a snapshot', async () => {
    process.env.CMS_WORKSPACE_ID = otherWorkspaceId;
    try {
      expect((await receiveRelease(request('foreign'), siteId)).status).toBe(404);
      expect(await readdir(directory)).toEqual([]);
    } finally {
      process.env.CMS_WORKSPACE_ID = workspaceId;
    }
  });

  it('keeps the first snapshot after a conflicting retry', async () => {
    expect((await receiveRelease(request('stable'), siteId)).status).toBe(201);
    expect((await receiveRelease(request('stable'), siteId)).status).toBe(200);
    expect((await receiveRelease(request('stable', { metadata: { ...metadata, templateVersion: '2.0.0' } }), siteId)).status).toBe(409);
    const row = await pool.query('SELECT "snapshotRef" FROM "Release" WHERE "siteId" = $1 AND "releaseId" = $2', [siteId, 'stable']);
    expect(await readFile(row.rows[0].snapshotRef)).toEqual(snapshot);
  });

  it('stores only one release for concurrent identical uploads', async () => {
    const statuses = await Promise.all(Array.from({ length: 4 }, () => receiveRelease(request('concurrent'), siteId).then(response => response.status)));
    expect(statuses.sort()).toEqual([200, 200, 200, 201]);
    const rows = await pool.query('SELECT "snapshotRef" FROM "Release" WHERE "siteId" = $1 AND "releaseId" = $2', [siteId, 'concurrent']);
    expect(rows.rowCount).toBe(1);
    expect(await readFile(rows.rows[0].snapshotRef)).toEqual(snapshot);
    expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('does not erase the existing snapshot when a failed transaction reuses its file key', async () => {
    const releaseId = 'retained';
    const key = createHash('sha256').update(`${siteId}:${releaseId}`).digest('hex');
    const path = join(directory, `${key}.snapshot`);
    const original = Buffer.from('original snapshot');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, original);
    expect((await receiveRelease(request(releaseId), siteId)).status).toBe(503);
    expect(await readFile(path)).toEqual(original);
    const row = await pool.query('SELECT "id" FROM "Release" WHERE "siteId" = $1 AND "releaseId" = $2', [siteId, releaseId]);
    expect(row.rowCount).toBe(0);
  });
});
