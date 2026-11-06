import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '@gateway/contracts';
import { provisionSite, type ProvisionResult } from '../src/provisioning';
import { authenticateSiteService } from '../src/service-scope';
import { readSiteInfo } from '../src/site-info';
import { readPublicationState } from '../src/publication-state';
import { readPublishOperation } from '../src/publish-operation';

const connectionString = process.env.GATEWAY_TEST_DATABASE_URL;
const run = connectionString ? describe : describe.skip;
run('service source authorization PostgreSQL and HTTP handlers', () => {
  const pool = new Pool({ connectionString });
  const instanceId = `cms-test-${randomUUID()}`;
  const sources = Array.from({ length: 2 }, () => ({ cmsWorkspaceId: randomUUID(), cmsSiteId: randomUUID(), name: 'Scope test', requestKey: randomUUID() }));
  const operationIds = [randomUUID(), randomUUID()];
  const leadIds = [randomUUID(), randomUUID()];
  const sites: ProvisionResult[] = [];
  let directory: string;
  let leads: typeof import('../app/api/v1/sites/[siteId]/leads/route');
  let events: typeof import('../app/api/v1/sites/[siteId]/events/route');
  let domains: typeof import('../src/domains');
  let publish: typeof import('../src/publish');
  let releases: typeof import('../src/releases');
  let pins: typeof import('../src/template-pin');
  const manifest = { schemaVersion: 1, id: 'aeroframe', version: '1.0.1', compatibility: { cmsSchema: 1, releaseSchema: 1 }, presentation: { theme: {}, demo: {} }, models: [], pages: [], assets: [] };
  const record = { schemaVersion: 1, id: 'aeroframe', version: '1.0.1', manifestChecksum: `sha256:${createHash('sha256').update(canonicalJson(manifest)).digest('hex')}`, imageRepository: 'ghcr.io/tangtianshuo/independent-website-templates/aeroframe', imageDigest: `sha256:${'a'.repeat(64)}`, sourceCommit: 'b'.repeat(40), manifestPath: 'templates/aeroframe/1.0.1/template.json', status: 'available' };
  const headers = (index: number) => ({ authorization: 'Bearer scope-secret', 'X-CMS-Workspace': sources[index].cmsWorkspaceId, 'X-CMS-Site': sources[index].cmsSiteId });
  function request(index: number, method = 'GET', body?: unknown, extra?: HeadersInit, suffix = '') {
    return new Request(`http://local/api/v1/sites/${sites[index].siteId}${suffix}`, { method, headers: { ...headers(index), 'content-type': 'application/json', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  const context = (siteId: string) => ({ params: Promise.resolve({ siteId }) });
  beforeAll(async () => {
    process.env.DATABASE_URL = connectionString;
    process.env.CMS_SERVICE_SECRET = 'scope-secret';
    process.env.CMS_INSTANCE_ID = instanceId;
    delete process.env.CMS_WORKSPACE_ID;
    process.env.ALLOWED_TEMPLATE_IDS = 'aeroframe';
    directory = await mkdtemp(join(tmpdir(), 'gateway-scope-'));
    process.env.SNAPSHOT_STORAGE_PATH = directory;
    for (let index = 0; index < sources.length; index++) {
      const site = await provisionSite(pool, instanceId, sources[index], 'sites.localhost'); sites.push(site);
      await pool.query('INSERT INTO "Lead" ("id","workspaceId","siteId","source","name","fields","dedupeKey","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,now())', [leadIds[index], site.workspaceId, site.siteId, 'form', `Lead ${index}`, '{}', randomUUID()]);
      await pool.query('INSERT INTO "AnalyticsEvent" ("id","workspaceId","siteId","eventId","path","visitorHash") VALUES ($1,$2,$3,$4,$5,$6)', [randomUUID(), site.workspaceId, site.siteId, randomUUID(), `/workspace-${index}`, `visitor-${index}`]);
      await pool.query('INSERT INTO "Release" ("id","siteId","releaseId","checksum","metadata") VALUES ($1,$2,$3,$4,$5)', [randomUUID(), site.siteId, 'seed', 'sha256:seed', '{}']);
      await pool.query('INSERT INTO "PublishOperation" ("id","workspaceId","siteId","idempotencyKey","releaseId","expectedRevision","desiredRevision","status","updatedAt") VALUES ($1,$2,$3,$4,$5,0,1,$6,now())', [operationIds[index], site.workspaceId, site.siteId, randomUUID(), 'seed', 'failed']);
    }
    leads = await import('../app/api/v1/sites/[siteId]/leads/route'); events = await import('../app/api/v1/sites/[siteId]/events/route');
    domains = await import('../src/domains'); publish = await import('../src/publish'); releases = await import('../src/releases'); pins = await import('../src/template-pin');
    // Only the external public registry is doubled; authorization and all persistence are real.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/commits/registry')) return Response.json({ sha: 'e'.repeat(40) });
      if (url.endsWith('/registry/index.json')) return Response.json({ schemaVersion: 1, records: [record] });
      if (url.endsWith('/1.0.1/template.json')) return Response.json(manifest);
      throw new Error('Unexpected registry URL');
    }));
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await pool.query('DELETE FROM "SourceSiteBinding" WHERE "instanceId"=$1', [instanceId]);
    await pool.query('DELETE FROM "SourceWorkspaceBinding" WHERE "instanceId"=$1', [instanceId]);
    for (const site of sites) {
      for (const table of ['Lead', 'AnalyticsEvent', 'PublishOperation', 'Publication', 'ReleaseArtifact', 'Release', 'TemplatePin', 'Domain']) await pool.query(`DELETE FROM "${table}" WHERE "siteId"=$1`, [site.siteId]);
      await pool.query('DELETE FROM "Site" WHERE "id"=$1', [site.siteId]);
      await pool.query('DELETE FROM "Workspace" WHERE "id"=$1', [site.workspaceId]);
    }
    await pool.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function state() {
    const rows = [];
    for (const table of ['Site', 'Lead', 'AnalyticsEvent', 'PublishOperation', 'Publication', 'ReleaseArtifact', 'Release', 'TemplatePin', 'Domain']) rows.push((await pool.query(`SELECT to_jsonb(t) AS row FROM "${table}" t WHERE ${table === 'Site' ? '"id"' : '"siteId"'} = ANY($1::uuid[]) ORDER BY to_jsonb(t)::text`, [sites.map(site => site.siteId)])).rows);
    return rows;
  }
  it('authenticates each complete source without configuring the legacy workspace', async () => {
    for (let index = 0; index < sites.length; index++) await expect(authenticateSiteService(request(index), sites[index].siteId, pool)).resolves.toEqual({ workspaceId: sites[index].workspaceId });
  });
  it('denies partial, empty, mismatched, duplicate, and foreign-instance sources with no legacy fallback', async () => {
    process.env.CMS_WORKSPACE_ID = sites[0].workspaceId;
    const variants = [
      { 'X-CMS-Workspace': sources[0].cmsWorkspaceId }, { 'X-CMS-Site': sources[0].cmsSiteId },
      { 'X-CMS-Workspace': '', 'X-CMS-Site': sources[0].cmsSiteId },
      { 'X-CMS-Workspace': sources[1].cmsWorkspaceId, 'X-CMS-Site': sources[0].cmsSiteId },
      { 'X-CMS-Workspace': sources[0].cmsWorkspaceId, 'X-CMS-Site': `${sources[0].cmsSiteId},${sources[0].cmsSiteId}` },
    ];
    for (const source of variants) await expect(authenticateSiteService(new Request('http://local', { headers: { authorization: 'Bearer scope-secret', ...source } as HeadersInit }), sites[0].siteId, pool)).rejects.toThrow();
    process.env.CMS_INSTANCE_ID = 'foreign-instance';
    await expect(authenticateSiteService(request(0), sites[0].siteId, pool)).rejects.toThrow();
    delete process.env.CMS_INSTANCE_ID;
    await expect(authenticateSiteService(request(0), sites[0].siteId, pool)).rejects.toThrow();
    process.env.CMS_INSTANCE_ID = instanceId;
    delete process.env.CMS_WORKSPACE_ID;
  });
  it('permits legacy access only to the configured workspace when both source headers are absent', async () => {
    process.env.CMS_WORKSPACE_ID = sites[0].workspaceId;
    const legacy = new Request('http://local', { headers: { authorization: 'Bearer scope-secret' } });
    await expect(authenticateSiteService(legacy, sites[0].siteId, pool)).resolves.toEqual({ workspaceId: sites[0].workspaceId });
    await expect(authenticateSiteService(legacy, sites[1].siteId, pool)).rejects.toThrow();
    expect((await leads.GET(legacy, context(sites[0].siteId))).status).toBe(200);
    expect((await leads.GET(legacy, context(sites[1].siteId))).status).toBe(404);
    expect((await events.GET(legacy, context(sites[1].siteId))).status).toBe(404);
    const before = await state();
    expect((await resources(0, 1, { authorization: 'Bearer scope-secret' })).map(result => result.status)).toEqual(Array(11).fill(404));
    expect(await state()).toEqual(before);
    expect(await readdir(directory)).toEqual([]);
    delete process.env.CMS_WORKSPACE_ID;
    expect((await leads.GET(legacy, context(sites[0].siteId))).status).toBe(401);
  });
  async function resources(index: number, target: number, sourceHeaders: Record<string, string> = headers(index)) {
    const site = sites[target];
    const scoped = (method = 'GET', body?: unknown, suffix = '') => new Request(`http://local/api/v1/sites/${site.siteId}${suffix}`, {
      method, headers: { ...sourceHeaders, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const snapshot = Buffer.from(JSON.stringify({ schemaVersion: 1, workspaceId: site.workspaceId, siteId: site.siteId, language: 'en', pages: [], navigation: [], redirects: [] }));
    const releaseBody = { workspaceId: site.workspaceId, siteId: site.siteId, releaseId: `upload-${index}-${target}`, checksum: `sha256:${createHash('sha256').update(snapshot).digest('hex')}`, metadata: { templateId: record.id, templateVersion: record.version, manifestChecksum: record.manifestChecksum, imageDigest: record.imageDigest }, snapshot: snapshot.toString('base64') };
    return [
      await readSiteInfo(scoped(), site.siteId, pool),
      await readPublicationState(scoped(), site.siteId, pool),
      await readPublishOperation(scoped(), site.siteId, operationIds[target], pool),
      await domains.readDomainState(scoped(), site.siteId),
      await leads.GET(scoped(), context(site.siteId)),
      await events.GET(scoped(), context(site.siteId)),
      await leads.PATCH(scoped('PATCH', { status: 'contacted', workspaceId: site.workspaceId }, `?id=${leadIds[target]}`), context(site.siteId)),
      await pins.updateTemplatePin(scoped('PUT', { templateId: 'aeroframe', templateVersion: '1.0.1', workspaceId: site.workspaceId }), site.siteId),
      await releases.receiveRelease(scoped('POST', releaseBody), site.siteId),
      await publish.createPublishOperation(scoped('POST', { releaseId: 'seed', idempotencyKey: `publish-${index}-${target}`, expectedRevision: 0, workspaceId: site.workspaceId }), site.siteId),
      await domains.reserveDomain(scoped('POST', { hostname: `scope-${index}-${site.siteId}.example`, workspaceId: site.workspaceId }), site.siteId),
    ];
  }
  it('denies every management resource across both workspaces and preserves all SQL rows and artifact files', async () => {
    const before = await state();
    const files = await readdir(directory);
    for (const [index, target] of [[0, 1], [1, 0]]) {
      const results = await resources(index, target);
      expect(results.map(result => result.status)).toEqual(Array(11).fill(404));
      expect(await state()).toEqual(before);
      expect(await readdir(directory)).toEqual(files);
    }
  });
  it('rejects partial and forged source headers on every management handler despite a matching legacy workspace', async () => {
    const before = await state();
    process.env.CMS_WORKSPACE_ID = sites[0].workspaceId;
    try {
      for (const source of [
        { authorization: 'Bearer scope-secret', 'X-CMS-Workspace': sources[0].cmsWorkspaceId },
        { authorization: 'Bearer scope-secret', 'X-CMS-Site': sources[0].cmsSiteId },
        { ...headers(0), 'X-CMS-Workspace': sources[1].cmsWorkspaceId },
        { ...headers(0), 'X-CMS-Site': '' },
      ]) expect((await resources(0, 0, source as Record<string, string>)).map(result => result.status)).toEqual(Array(11).fill(404));
      expect(await state()).toEqual(before);
      expect(await readdir(directory)).toEqual([]);
      process.env.CMS_INSTANCE_ID = 'forged-instance';
      expect((await resources(0, 0)).map(result => result.status)).toEqual(Array(11).fill(404));
      delete process.env.CMS_INSTANCE_ID;
      expect((await resources(0, 0)).map(result => result.status)).toEqual(Array(11).fill(401));
      expect(await state()).toEqual(before);
    } finally { delete process.env.CMS_WORKSPACE_ID; process.env.CMS_INSTANCE_ID = instanceId; }
  });
  it('returns 401 for every unauthenticated management resource before any write', async () => {
    const before = await state();
    process.env.CMS_SERVICE_SECRET = 'different-secret';
    try { expect((await resources(0, 0)).map(result => result.status)).toEqual(Array(11).fill(401)); }
    finally { process.env.CMS_SERVICE_SECRET = 'scope-secret'; }
    expect(await state()).toEqual(before);
  });
  it('allows every management resource for each owning source and keeps returned leads/statistics isolated', async () => {
    for (let index = 0; index < sites.length; index++) {
      const results = await resources(index, index);
      expect(results.map(result => result.status)).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 201, 201, 201]);
      expect((await results[4].json()).items.map((item: { id: string }) => item.id)).toEqual([leadIds[index]]);
      expect((await results[5].json()).pages.map((item: { path: string }) => item.path)).toEqual([`/workspace-${index}`]);
      expect((await pool.query('SELECT "status" FROM "Lead" WHERE "id"=$1', [leadIds[index]])).rows[0].status).toBe('contacted');
      expect((await pool.query('SELECT "workspaceId" FROM "PublishOperation" WHERE "siteId"=$1 AND "idempotencyKey"=$2', [sites[index].siteId, `publish-${index}-${index}`])).rows[0].workspaceId).toBe(sites[index].workspaceId);
    }
  });
});
