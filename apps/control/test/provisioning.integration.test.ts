import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionSite } from '../src/provisioning';

const connectionString = process.env.GATEWAY_TEST_DATABASE_URL;
const run = connectionString ? describe : describe.skip;
run('source provisioning PostgreSQL integration', () => {
  const pool = new Pool({ connectionString });
  const instanceId = `cms-test-${randomUUID()}`;
  const input = { cmsWorkspaceId: randomUUID(), cmsSiteId: randomUUID(), name: '站点 A', requestKey: randomUUID() };
  let post: typeof import('../app/api/v1/site-provisioning/route').POST;
  beforeAll(async () => {
    process.env.DATABASE_URL = connectionString;
    process.env.CMS_SERVICE_SECRET = 'provision-secret';
    process.env.CMS_INSTANCE_ID = instanceId;
    process.env.PLATFORM_DOMAIN = 'sites.localhost';
    delete process.env.CMS_WORKSPACE_ID;
    ({ POST: post } = await import('../app/api/v1/site-provisioning/route'));
  });
  afterAll(async () => {
    const rows = await pool.query('SELECT "siteId" FROM "SourceSiteBinding" WHERE "instanceId"=$1', [instanceId]);
    const workspaces = await pool.query('SELECT "workspaceId" FROM "SourceWorkspaceBinding" WHERE "instanceId"=$1', [instanceId]);
    await pool.query('DELETE FROM "SourceSiteBinding" WHERE "instanceId"=$1', [instanceId]);
    await pool.query('DELETE FROM "SourceWorkspaceBinding" WHERE "instanceId"=$1', [instanceId]);
    for (const { siteId } of rows.rows) {
      await pool.query('DELETE FROM "Domain" WHERE "siteId"=$1', [siteId]);
      await pool.query('DELETE FROM "Site" WHERE "id"=$1', [siteId]);
    }
    for (const { workspaceId } of workspaces.rows) await pool.query('DELETE FROM "Workspace" WHERE "id"=$1', [workspaceId]);
    await pool.end();
  });
  const request = (body: unknown = input, authorization = 'Bearer provision-secret') => new Request('http://local/api/v1/site-provisioning', {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const counts = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM "Workspace") AS workspaces,
    (SELECT count(*)::int FROM "Site") AS sites,
    (SELECT count(*)::int FROM "Domain") AS domains,
    (SELECT count(*)::int FROM "SourceWorkspaceBinding") AS workspacesources,
    (SELECT count(*)::int FROM "SourceSiteBinding") AS sitesources`)).rows[0];

  it('creates exactly one identity under eight concurrent retries and reserves an unready default domain', async () => {
    const before = await counts();
    const results = await Promise.all(Array.from({ length: 8 }, () => provisionSite(pool, instanceId, input, 'sites.localhost')));
    expect(new Set(results.map(value => value.siteId)).size).toBe(1);
    expect(results.every(value => value.status === 'provisioned')).toBe(true);
    const first = results[0];
    expect(first).toMatchObject({ cmsWorkspaceId: input.cmsWorkspaceId, cmsSiteId: input.cmsSiteId, status: 'provisioned' });
    expect(first.siteUrl).toBe(`https://s-${first.siteId.replaceAll('-', '')}.sites.localhost`);
    expect((await pool.query('SELECT count(*)::int AS count FROM "SourceSiteBinding" WHERE "instanceId"=$1 AND "cmsSiteId"=$2', [instanceId, input.cmsSiteId])).rows[0].count).toBe(1);
    expect(await counts()).toEqual(Object.fromEntries(Object.entries(before).map(([key, value]) => [key, (value as number) + 1])));
    expect((await pool.query('SELECT "status","ownershipStatus","dnsStatus","certificateStatus","isPrimary" FROM "Domain" WHERE "siteId"=$1', [first.siteId])).rows[0]).toEqual({ status: 'pending', ownershipStatus: 'pending', dnsStatus: 'pending', certificateStatus: 'pending', isPrimary: true });
    expect((await pool.query('SELECT * FROM "ActiveDeployment" WHERE "siteId"=$1', [first.siteId])).rowCount).toBe(0);
  });
  it('recovers a lost response, rejects a changed request key, and replays the original identity', async () => {
    const first = await provisionSite(pool, instanceId, input, 'sites.localhost');
    expect(await provisionSite(pool, instanceId, input, 'sites.localhost')).toEqual(first);
    const before = await counts();
    await expect(provisionSite(pool, instanceId, { ...input, requestKey: randomUUID() }, 'sites.localhost')).rejects.toMatchObject({ status: 409, message: 'binding_conflict' });
    expect((await post(request({ ...input, requestKey: randomUUID() }))).status).toBe(409);
    expect(await counts()).toEqual(before);
    expect(await provisionSite(pool, instanceId, input, 'sites.localhost')).toEqual(first);
    const second = await provisionSite(pool, instanceId, { ...input, cmsSiteId: randomUUID(), requestKey: randomUUID() }, 'sites.localhost');
    expect(second.siteId).not.toBe(first.siteId);
    expect(second.workspaceId).toBe(first.workspaceId);
  });
  it('returns 409 for request key reuse with another source tuple and leaves no orphan rows', async () => {
    const before = await counts();
    for (const changed of [{ cmsSiteId: randomUUID() }, { cmsWorkspaceId: randomUUID() }]) {
      const response = await post(request({ ...input, ...changed }));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'binding_conflict' });
      expect(await counts()).toEqual(before);
    }
  });
  it('rolls back concurrent request key collisions across distinct source workspaces', async () => {
    const before = await counts();
    const requestKey = randomUUID();
    const results = await Promise.all(Array.from({ length: 8 }, () => post(request({ ...input, cmsWorkspaceId: randomUUID(), cmsSiteId: randomUUID(), requestKey }))));
    expect(results.map(result => result.status).sort()).toEqual([200, 409, 409, 409, 409, 409, 409, 409]);
    expect(await counts()).toEqual(Object.fromEntries(Object.entries(before).map(([key, value]) => [key, (value as number) + 1])));
  });
  it('derives instance and Gateway identity from backend configuration, ignoring forged body authority', async () => {
    const response = await post(request({ ...input, instanceId: 'forged-instance', workspaceId: randomUUID(), siteId: randomUUID(), siteUrl: 'https://evil.example', status: 'active' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(await provisionSite(pool, instanceId, input, 'sites.localhost'));
    expect((await pool.query('SELECT * FROM "SourceSiteBinding" WHERE "instanceId"=$1', ['forged-instance'])).rowCount).toBe(0);
  });
  it('rejects missing credentials, missing backend instance, and malformed input without writes', async () => {
    const before = await counts();
    expect((await post(request(input, ''))).status).toBe(401);
    delete process.env.CMS_INSTANCE_ID;
    expect((await post(request({ ...input, instanceId }))).status).toBe(401);
    process.env.CMS_INSTANCE_ID = instanceId;
    for (const body of [null, [], { ...input, requestKey: '' }, { ...input, cmsWorkspaceId: 'a,b' }, { ...input, cmsSiteId: ' ' }, { ...input, name: '' }]) expect((await post(request(body))).status).toBe(400);
    expect(await counts()).toEqual(before);
  });
  it('replays the exact reserved default after primary switch and platform configuration drift', async () => {
    const first = await provisionSite(pool, instanceId, input, 'sites.localhost');
    await pool.query('UPDATE "Domain" SET "isPrimary"=false WHERE "siteId"=$1', [first.siteId]);
    await pool.query('INSERT INTO "Domain" ("id","siteId","hostname","isPrimary","updatedAt") VALUES ($1,$2,$3,true,now())', [randomUUID(), first.siteId, 'custom-'+first.siteId+'.example']);
    await expect(provisionSite(pool, instanceId, input, '')).resolves.toEqual(first);
    await expect(provisionSite(pool, instanceId, input, 'new-platform.example')).resolves.toEqual(first);
  });
  it('enforces workspace/site ownership in SQL, even for manually forged binding writes', async () => {
    const a = await provisionSite(pool, instanceId, input, 'sites.localhost');
    const bInput = { ...input, cmsWorkspaceId: randomUUID(), cmsSiteId: randomUUID(), requestKey: randomUUID() };
    const b = await provisionSite(pool, instanceId, bInput, 'sites.localhost');
    const bDomain = (await pool.query('SELECT "defaultDomainId" FROM "SourceSiteBinding" WHERE "siteId"=$1', [b.siteId])).rows[0].defaultDomainId;
    await expect(pool.query('UPDATE "SourceSiteBinding" SET "defaultDomainId"=$1 WHERE "siteId"=$2', [bDomain, a.siteId])).rejects.toHaveProperty('code', '23503');
    await expect(pool.query('DELETE FROM "Domain" WHERE "id"=$1', [bDomain])).rejects.toHaveProperty('code', '23001');
    await expect(pool.query('UPDATE "SourceSiteBinding" SET "siteId"=$1 WHERE "instanceId"=$2 AND "cmsSiteId"=$3', [b.siteId, instanceId, input.cmsSiteId])).rejects.toHaveProperty('code');
    expect((await pool.query('SELECT "workspaceId" FROM "Site" WHERE "id"=$1', [a.siteId])).rows[0].workspaceId).toBe(a.workspaceId);
  });
});
