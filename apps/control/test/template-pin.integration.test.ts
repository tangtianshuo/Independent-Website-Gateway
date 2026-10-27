import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '@gateway/contracts';
import type { updateTemplatePin as PinHandler } from '../src/template-pin';
import { readPublishOperation } from '../src/publish-operation';
import { readPublishedRelease } from '../src/published-release';

const connectionString = process.env.GATEWAY_TEST_DATABASE_URL;
const run = connectionString ? describe : describe.skip;

run('public template pin PostgreSQL integration', () => {
  const pool = new Pool({ connectionString });
  const workspaceId = randomUUID();
  const foreignWorkspaceId = randomUUID();
  const siteId = randomUUID();
  const foreignSiteId = randomUUID();
  const operationId = randomUUID();
  const oldDigest = `sha256:${'a'.repeat(64)}`;
  const oldSecret = 'old-active-site-secret';
  let updateTemplatePin: typeof PinHandler;
  let directory: string;
  function publication(version: string) {
    const manifest = { schemaVersion: 1, id: 'aeroframe', version, compatibility: { cmsSchema: 1, releaseSchema: 1 }, presentation: { theme: {}, demo: {} }, models: [], pages: [], assets: [] };
    return { manifest, record: { schemaVersion: 1, id: 'aeroframe', version,
      manifestChecksum: `sha256:${createHash('sha256').update(canonicalJson(manifest)).digest('hex')}`,
      imageRepository: 'ghcr.io/tangtianshuo/independent-website-templates/aeroframe',
      imageDigest: `sha256:${(version === '1.0.1' ? 'b' : 'c').repeat(64)}`, sourceCommit: 'd'.repeat(40),
      manifestPath: `templates/aeroframe/${version}/template.json`, status: 'available' } };
  }
  function request(version = '1.0.1', authorization: string | null = 'Bearer pin-secret') {
    return new Request(`http://localhost/api/v1/sites/${siteId}/template-pin`, { method: 'PUT',
      headers: authorization ? { authorization, 'content-type': 'application/json' } : {},
      body: JSON.stringify({ templateId: 'aeroframe', templateVersion: version }) });
  }
  async function oldSiteStillServes() {
    const response = await readPublishedRelease(new Request(`http://local/api/v1/sites/${siteId}/published-release`, { headers: { authorization: `Bearer ${oldSecret}` } }), siteId, pool);
    expect(response.status).toBe(200);
    expect((await response.json()).releaseId).toBe('old-active');
    expect((await pool.query('SELECT "releaseId","imageDigest","routeRevision" FROM "ActiveDeployment" WHERE "siteId"=$1', [siteId])).rows[0]).toEqual({ releaseId: 'old-active', imageDigest: oldDigest, routeRevision: 0 });
  }
  beforeAll(async () => {
    process.env.DATABASE_URL = connectionString;
    process.env.CMS_SERVICE_SECRET = 'pin-secret';
    process.env.CMS_WORKSPACE_ID = workspaceId;
    ({ updateTemplatePin } = await import('../src/template-pin'));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/commits/registry')) return Response.json({ sha: 'e'.repeat(40) });
      if (url.endsWith('/registry/index.json')) return Response.json({ schemaVersion: 1, records: [publication('1.0.1').record, publication('1.0.2').record] });
      if (url.endsWith('/1.0.1/template.json')) return Response.json(publication('1.0.1').manifest);
      if (url.endsWith('/1.0.2/template.json')) return Response.json(publication('1.0.2').manifest);
      throw new Error('Unexpected registry URL');
    }));
    await pool.query('INSERT INTO "Workspace" ("id","name","updatedAt") VALUES ($1,$2,now()),($3,$4,now())', [workspaceId, 'pin owner', foreignWorkspaceId, 'foreign pin owner']);
    await pool.query('INSERT INTO "Site" ("id","workspaceId","credentialHash","updatedAt") VALUES ($1,$2,$3,now()),($4,$5,NULL,now())', [siteId, workspaceId, createHash('sha256').update(oldSecret).digest('hex'), foreignSiteId, foreignWorkspaceId]);
    directory = await mkdtemp(join(tmpdir(), 'gateway-pin-test-'));
    const snapshot = Buffer.from(JSON.stringify({ schemaVersion: 1, workspaceId, siteId, language: 'en', pages: [], navigation: [], redirects: [] }));
    const path = join(directory, 'old.snapshot');
    await writeFile(path, snapshot);
    await pool.query('INSERT INTO "Release" ("id","siteId","releaseId","checksum","metadata","snapshotRef") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [randomUUID(), siteId, 'old-active', `sha256:${createHash('sha256').update(snapshot).digest('hex')}`, '{}', path]);
    await pool.query('INSERT INTO "ActiveDeployment" ("id","siteId","releaseId","imageDigest","routeRevision") VALUES ($1,$2,$3,$4,0)', [randomUUID(), siteId, 'old-active', oldDigest]);
    await pool.query('INSERT INTO "TemplatePin" ("id","siteId","templateId","version","imageDigest","updatedAt") VALUES ($1,$2,$3,$4,$5,now())', [randomUUID(), siteId, 'aeroframe', '1.0.0', oldDigest]);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    for (const table of ['ActiveDeployment', 'PublishOperation', 'Release', 'TemplatePin']) await pool.query(`DELETE FROM "${table}" WHERE "siteId" IN ($1,$2)`, [siteId, foreignSiteId]);
    await pool.query('DELETE FROM "Site" WHERE "id" IN ($1,$2)', [siteId, foreignSiteId]);
    await pool.query('DELETE FROM "Workspace" WHERE "id" IN ($1,$2)', [workspaceId, foreignWorkspaceId]);
    await pool.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  it('rejects unauthorized and foreign workspace writes without changing the legacy pin', async () => {
    expect((await updateTemplatePin(request('1.0.1', null), siteId)).status).toBe(401);
    expect((await updateTemplatePin(request(), foreignSiteId)).status).toBe(404);
    expect((await pool.query('SELECT "version" FROM "TemplatePin" WHERE "siteId"=$1', [siteId])).rows[0].version).toBe('1.0.0');
    await oldSiteStillServes();
  });
  it('adopts the full verified public pin without changing the active release or its credential', async () => {
    expect((await updateTemplatePin(request(), siteId)).status).toBe(200);
    const pin = (await pool.query('SELECT "version","imageRepository","imageDigest","manifestChecksum","sourceCommit" FROM "TemplatePin" WHERE "siteId"=$1', [siteId])).rows[0];
    expect(pin).toEqual({ version: '1.0.1', imageRepository: publication('1.0.1').record.imageRepository, imageDigest: publication('1.0.1').record.imageDigest, manifestChecksum: publication('1.0.1').record.manifestChecksum, sourceCommit: publication('1.0.1').record.sourceCommit });
    await oldSiteStillServes();
  });
  it('replays an identical pin during pending publication and rejects a changed pin without mutation', async () => {
    await pool.query('INSERT INTO "PublishOperation" ("id","workspaceId","siteId","idempotencyKey","releaseId","expectedRevision","desiredRevision","updatedAt") VALUES ($1,$2,$3,$4,$5,0,1,now())', [operationId, workspaceId, siteId, randomUUID(), 'old-active']);
    const before = (await pool.query('SELECT * FROM "TemplatePin" WHERE "siteId"=$1', [siteId])).rows[0];
    expect((await updateTemplatePin(request(), siteId)).status).toBe(200);
    expect((await updateTemplatePin(request('1.0.2'), siteId)).status).toBe(409);
    expect((await pool.query('SELECT * FROM "TemplatePin" WHERE "siteId"=$1', [siteId])).rows[0]).toEqual(before);
    await oldSiteStillServes();
  });
  it('scopes real operation status to both the owning workspace and site', async () => {
    const auth = new Request('http://local', { headers: { authorization: 'Bearer pin-secret' } });
    expect((await readPublishOperation(auth, siteId, operationId, pool)).status).toBe(200);
    expect((await readPublishOperation(auth, foreignSiteId, operationId, pool)).status).toBe(404);
    process.env.CMS_WORKSPACE_ID = foreignWorkspaceId;
    try { expect((await readPublishOperation(auth, siteId, operationId, pool)).status).toBe(404); }
    finally { process.env.CMS_WORKSPACE_ID = workspaceId; }
  });
  it('allows the explicit next pin after the pending attempt fails while the old site still serves', async () => {
    await pool.query('UPDATE "PublishOperation" SET "status"=$1 WHERE "id"=$2', ['failed', operationId]);
    expect((await updateTemplatePin(request('1.0.2'), siteId)).status).toBe(200);
    expect((await pool.query('SELECT "version" FROM "TemplatePin" WHERE "siteId"=$1', [siteId])).rows[0].version).toBe('1.0.2');
    await oldSiteStillServes();
  });
});
