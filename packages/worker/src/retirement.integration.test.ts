import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { collectRetiredContainers } from './retirement.js';

const connectionString = process.env.GATEWAY_TEST_DATABASE_URL;
test('collection fences active/previous routes, pending leases, mismatched state, and retries after restart', { skip: !connectionString }, async () => {
  const schema = `gc_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  for (const table of ['Workspace', 'Site', 'Release', 'TemplatePin', 'ActiveDeployment', 'PublishOperation']) {
    await admin.query(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
  }
  const pool = new Pool({ connectionString, options: `-c search_path=${schema},public` });
  const workspaceId = randomUUID(), siteId = randomUUID();
  const image = `sha256:${'a'.repeat(64)}`;
  const ids = ['1','2','3','4','5'].map(n => n.repeat(64));
  const remaining = new Set(ids);
  let fail = true;
  const engine = {
    async list() { return [...remaining].map(Id => ({ Id, Labels: { 'gateway.site-id': siteId, 'gateway.release-id': 'release' } })); },
    async retire(id: string, identity: { siteId: string; workspaceId: string; image: string }) {
      assert.equal(identity.siteId, siteId); assert.equal(identity.workspaceId, workspaceId); assert.equal(identity.image, image);
      if (fail) throw new Error('Docker unavailable');
      remaining.delete(id); return true;
    },
  };
  const route = { siteId, releaseId: 'release', revision: 2, containerId: ids[0], host: 'site.test', port: 49152, token: 'token' };
  const previous = { ...route, revision: 1, containerId: ids[1] };
  const gc = (routes = [route, previous]) => collectRetiredContainers(pool, routes, engine);
  try {
    await pool.query('INSERT INTO "Workspace" ("id", "name", "updatedAt") VALUES ($1, $2, now())', [workspaceId, 'gc-test']);
    await pool.query('INSERT INTO "Site" ("id", "workspaceId", "updatedAt") VALUES ($1, $2, now())', [siteId, workspaceId]);
    await pool.query('INSERT INTO "Release" ("id", "siteId", "releaseId", "checksum", "metadata", "snapshotRef") VALUES ($1, $2, $3, $4, $5, $6)',
      [randomUUID(), siteId, 'release', 'test', { imageDigest: image, templateId: 'storefront', templateVersion: '1' }, '/snapshot']);
    await pool.query('INSERT INTO "TemplatePin" ("id", "siteId", "templateId", "version", "imageDigest", "updatedAt") VALUES ($1, $2, $3, $4, $5, now())', [randomUUID(), siteId, 'storefront', '1', image]);
    await pool.query('INSERT INTO "ActiveDeployment" ("id", "siteId", "releaseId", "imageDigest", "routeRevision") VALUES ($1, $2, $3, $4, 2)', [randomUUID(), siteId, 'release', image]);
    assert.equal((await gc([])).removed, 0);
    assert.equal((await gc([{ ...route, revision: 1 }])).removed, 0);
    const op = randomUUID();
    await pool.query('INSERT INTO "PublishOperation" ("id", "workspaceId", "siteId", "idempotencyKey", "releaseId", "expectedRevision", "desiredRevision", "leaseUntil", "updatedAt") VALUES ($1, $2, $3, $5, $4, 2, 3, now() - interval \'1 second\', now())', [op, workspaceId, siteId, 'release', randomUUID()]);
    assert.equal((await gc()).removed, 0, 'even expired pending attempts must be reconciled first');
    await pool.query('UPDATE "PublishOperation" SET "status" = \'failed\' WHERE "id" = $1', [op]);
    assert.equal((await gc()).failed, 3);
    assert.equal(remaining.size, 5);
    fail = false; // Fresh invocation discovers residuals, without an in-memory retry queue.
    assert.equal((await gc()).removed, 3);
    assert.deepEqual([...remaining], [ids[0], ids[1]]);
    assert.equal((await gc()).removed, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM "Release" WHERE "siteId" = $1', [siteId])).rows[0].n, 1);

    // The same Site row lock used by submitPublish prevents new intent entering during deletion.
    remaining.add(ids[2]);
    let enter!: () => void, resume!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const wait = new Promise<void>(resolve => { resume = resolve; });
    const collecting = collectRetiredContainers(pool, [route, previous], { ...engine, async retire(id, identity) { enter(); await wait; return engine.retire(id, identity); } });
    await entered;
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN'); await writer.query("SET LOCAL lock_timeout = '100ms'");
      await assert.rejects(writer.query('SELECT "id" FROM "Site" WHERE "id" = $1 FOR UPDATE', [siteId]), /lock timeout/);
    } finally { await writer.query('ROLLBACK'); writer.release(); resume(); }
    assert.equal((await collecting).removed, 1);
  } finally {
    for (const table of ['ActiveDeployment', 'PublishOperation', 'Release', 'TemplatePin']) await pool.query(`DELETE FROM "${table}" WHERE "siteId" = $1`, [siteId]);
    await pool.query('DELETE FROM "Site" WHERE "id" = $1', [siteId]);
    await pool.query('DELETE FROM "Workspace" WHERE "id" = $1', [workspaceId]);
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
