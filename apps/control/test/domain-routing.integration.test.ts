import { randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readDomainRoute } from '../../../packages/worker/src/domain-routing';
import { createLocalRouter } from '../../../packages/worker/src/runtime';
import { createTrafficProxy } from '../../../packages/traffic/src/index';

const connectionString = process.env.GATEWAY_TEST_DATABASE_URL;
(connectionString ? describe : describe.skip)('domain selection to traffic PostgreSQL integration', () => {
  const pool = new Pool({ connectionString }), workspaceId = randomUUID(), siteId = randomUUID();
  beforeAll(async () => {
    await pool.query('INSERT INTO "Workspace" ("id","name","updatedAt") VALUES ($1,$2,now())', [workspaceId, 'domain routing']);
    await pool.query('INSERT INTO "Site" ("id","workspaceId","updatedAt") VALUES ($1,$2,now())', [siteId, workspaceId]);
    await pool.query(`INSERT INTO "Domain" ("id","siteId","hostname","ownershipStatus","dnsStatus","certificateStatus","updatedAt") VALUES ($1,$2,'shop.example.test','verified','ready','ready',now())`, [randomUUID(), siteId]);
  });
  afterAll(async () => {
    await pool.query('DELETE FROM "Domain" WHERE "siteId"=$1', [siteId]); await pool.query('DELETE FROM "Site" WHERE "id"=$1', [siteId]); await pool.query('DELETE FROM "Workspace" WHERE "id"=$1', [workspaceId]); await pool.end();
  });
  it('serves a ready fallback host with no primary flag and redirects only the other aliases', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'domain-traffic-')), state = join(directory, 'routes.json');
    const upstream = createServer((_request, response) => response.end('published'));
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const router = createLocalRouter(state), proxy = createTrafficProxy(state); await proxy.listen(0);
    const fetchHost = (host: string) => new Promise<{ status: number; location?: string; body: string }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: proxy.port(), headers: { host } }, response => {
        let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode!, location: response.headers.location, body }));
      }); req.on('error', reject); req.end();
    });
    try {
      const apply = async () => { const route = await readDomainRoute(pool, siteId); await router.applyRoute(siteId, 1, (upstream.address() as { port: number }).port, route.host, 'token', 'container', 'release', route.redirectHosts); return route; };
      expect((await apply()).host).toBe('shop.example.test');
      expect(await fetchHost('shop.example.test')).toEqual({ status: 200, location: undefined, body: 'published' });
      await pool.query(`INSERT INTO "Domain" ("id","siteId","hostname","ownershipStatus","dnsStatus","certificateStatus","updatedAt") VALUES ($1,$2,'www.shop.example.test','verified','ready','ready',now())`, [randomUUID(), siteId]);
      expect((await apply()).redirectHosts).toEqual(['www.shop.example.test']);
      expect(await fetchHost('shop.example.test')).toMatchObject({ status: 200, body: 'published' });
      expect(await fetchHost('www.shop.example.test')).toMatchObject({ status: 301, location: 'https://shop.example.test/' });
    } finally { await proxy.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
  });
});
