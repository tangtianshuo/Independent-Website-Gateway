import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { reserveDomain as ReserveHandler } from '../src/domains';

const connectionString = process.env.GATEWAY_TEST_DATABASE_URL;
const run = connectionString ? describe : describe.skip;

run('domain PostgreSQL integration', () => {
  const pool = new Pool({ connectionString });
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const siteId = randomUUID();
  const otherSiteId = randomUUID();
  let reserveDomain: typeof ReserveHandler;

  function request(hostname: string, site = siteId, extra: Record<string, unknown> = {}) {
    return new Request(`http://localhost/api/v1/sites/${site}/domains`, {
      method: 'POST',
      headers: { authorization: 'Bearer domain-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ hostname, ...extra }),
    });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = connectionString;
    process.env.CMS_SERVICE_SECRET = 'domain-secret';
    process.env.CMS_WORKSPACE_ID = workspaceId;
    ({ reserveDomain } = await import('../src/domains'));
    await pool.query('INSERT INTO "Workspace" ("id", "name", "updatedAt") VALUES ($1, $2, now()), ($3, $4, now())', [workspaceId, 'owner', otherWorkspaceId, 'other']);
    await pool.query('INSERT INTO "Site" ("id", "workspaceId", "updatedAt") VALUES ($1, $2, now()), ($3, $4, now())', [siteId, workspaceId, otherSiteId, otherWorkspaceId]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM "Domain" WHERE "siteId" IN ($1, $2)', [siteId, otherSiteId]);
    await pool.query('DELETE FROM "Site" WHERE "id" IN ($1, $2)', [siteId, otherSiteId]);
    await pool.query('DELETE FROM "Workspace" WHERE "id" IN ($1, $2)', [workspaceId, otherWorkspaceId]);
    await pool.end();
  });

  it('requires ownership of the requested site', async () => {
    expect((await reserveDomain(request('foreign.example', otherSiteId), otherSiteId)).status).toBe(404);
    expect((await pool.query('SELECT "id" FROM "Domain" WHERE "hostname" = $1', ['foreign.example'])).rowCount).toBe(0);
  });

  it('normalizes and reserves globally without trusting a CMS DNS claim', async () => {
    const first = await reserveDomain(request('BÜCHER.Example.', siteId, { dnsVerified: true, status: 'active', certificateStatus: 'ready' }), siteId);
    expect(first.status, JSON.stringify(await first.clone().json())).toBe(201);
    expect(await first.json()).toMatchObject({ hostname: 'xn--bcher-kva.example', status: 'pending', certificateStatus: 'pending' });
    const row = await pool.query('SELECT "siteId", "hostname", "status", "certificateStatus" FROM "Domain" WHERE "hostname" = $1', ['xn--bcher-kva.example']);
    expect(row.rows[0]).toMatchObject({ siteId, hostname: 'xn--bcher-kva.example', status: 'pending', certificateStatus: 'pending' });
    expect((await reserveDomain(request('XN--BCHER-KVA.EXAMPLE'), siteId)).status).toBe(409);
    expect((await reserveDomain(request('bücher.example', otherSiteId), otherSiteId)).status).toBe(404);
  });

  it('lets the database constraint resolve concurrent reservations across sites', async () => {
    const statuses = await Promise.all(Array.from({ length: 6 }, () => reserveDomain(request('PARALLEL.Example.'), siteId).then(response => response.status)));
    expect(statuses.sort()).toEqual([201, 409, 409, 409, 409, 409]);
    expect((await pool.query('SELECT "id" FROM "Domain" WHERE "hostname" = $1', ['parallel.example'])).rowCount).toBe(1);
  });

  it('does not reserve a hostname already held by another workspace', async () => {
    await pool.query('INSERT INTO "Domain" ("id", "siteId", "hostname", "updatedAt") VALUES ($1, $2, $3, now())', [randomUUID(), otherSiteId, 'claimed.example']);
    expect((await reserveDomain(request('CLAIMED.Example.'), siteId)).status).toBe(409);
    expect((await pool.query('SELECT "siteId" FROM "Domain" WHERE "hostname" = $1', ['claimed.example'])).rows[0].siteId).toBe(otherSiteId);
  });
});
