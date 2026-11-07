import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createRetirementClient } from './retirement.js';

const siteId = randomUUID(), workspaceId = randomUUID();
const id = 'a'.repeat(64);
const identity = { siteId, workspaceId, releaseId: 'old', image: `registry.example.com/templates/storefront@sha256:${'b'.repeat(64)}` };
function container() {
  return { Id: id, Name: `/gateway-${siteId}-${randomUUID()}`, Mounts: [],
    Config: { Image: identity.image, User: '10001:10001', Labels: { 'gateway.site-id': siteId, 'gateway.release-id': 'old' },
      Env: [`SITE_ID=${siteId}`, 'RELEASE_ID=old', `NUXT_WORKSPACE_ID=${workspaceId}`, `NUXT_SITE_ID=${siteId}`] },
    HostConfig: { NetworkMode: 'gateway-sites', ReadonlyRootfs: true, Privileged: false,
      CapAdd: null, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
      Memory: 536870912, NanoCpus: 500000000, PidsLimit: 128,
      PortBindings: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '49152' }] } } };
}
async function engine(info: unknown, run: (client: ReturnType<typeof createRetirementClient>, removed: string[]) => Promise<void>, deleteStatus = 204) {
  const removed: string[] = [];
  const server = createServer((req, res) => {
    if (req.method === 'DELETE') { removed.push(req.url!); res.writeHead(deleteStatus); res.end(); }
    else { res.writeHead(200); res.end(JSON.stringify(info)); }
  });
  const path = `/tmp/gateway-retire-${randomUUID()}.sock`;
  await new Promise<void>(resolve => server.listen(path, resolve));
  try { await run(createRetirementClient(path), removed); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
test('retirement re-inspects exact owned stateless container before deleting without volumes', async () => {
  await engine(container(), async (client, removed) => {
    assert.equal(await client.retire(id, identity), true);
    assert.deepEqual(removed, [`/containers/${id}?force=true`]);
  });
});
test('retirement accepts the immutable published snapshot bind mount', async () => {
  await engine({ ...container(), Mounts: [{ Type: 'bind', Source: '/var/lib/gateway/snapshots/release.snapshot', Destination: '/var/lib/gateway/artifacts/published.json', Mode: 'ro', RW: false }] }, async (client, removed) => {
    assert.equal(await client.retire(id, identity), true);
    assert.deepEqual(removed, [`/containers/${id}?force=true`]);
  });
});
test('retirement refuses foreign, mounted, privileged, writable and unexpected image containers', async () => {
  const unsafe = [
    { ...container(), Id: 'c'.repeat(64) },
    { ...container(), Name: '/user-service' },
    { ...container(), Mounts: [{ Type: 'volume', Name: 'user-data' }] },
    ...[
      { NetworkMode: 'other-network' }, { Privileged: true }, { ReadonlyRootfs: false },
      { CapAdd: ['SYS_ADMIN'] }, { CapDrop: [] }, { SecurityOpt: [] },
      { PortBindings: { '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '49152' }] } },
    ].map(patch => ({ ...container(), HostConfig: { ...container().HostConfig, ...patch } })),
    ...[{ Image: 'user/image:latest' }, { User: 'root' }, { Labels: {} }, { Env: [] }]
      .map(patch => ({ ...container(), Config: { ...container().Config, ...patch } })),
  ];
  for (const info of unsafe) await engine(info, async (client, removed) => {
    assert.equal(await client.retire(id, identity), false);
    assert.deepEqual(removed, []);
  });
});
test('Docker deletion errors stay retryable and malformed IDs never reach the socket', async () => {
  await engine(container(), async client => {
    await assert.rejects(client.retire(id, identity), /Docker retirement request failed/);
    await assert.rejects(client.retire('../user', identity), /Invalid container/);
  }, 500);
});
test('already absent container retirement is idempotent', async () => {
  await engine(container(), async client => assert.equal(await client.retire(id, identity), true), 404);
});

test('listing is limited to Gateway labels and rejects malformed ownership records', async () => {
  await engine([{ Id: id, Labels: { 'gateway.site-id': siteId, 'gateway.release-id': 'old' } }], async (client, removed) => {
    assert.equal((await client.list())[0].Id, id);
    assert.deepEqual(removed, []);
  });
  await engine([{ Id: '../other', Labels: {} }], async client => {
    await assert.rejects(client.list(), /Invalid Docker retirement listing/);
  });
});

test('source and recovery retirement use disjoint listing filters and reinspection ownership', async () => {
  const scope = 'restore-' + 'a'.repeat(24);
  const ordinary = container();
  const recovery = { ...ordinary, Config: { ...ordinary.Config, Labels: { 'gateway.restore.site-id': siteId, 'gateway.restore.release-id': 'old', 'gateway.runtime-scope': scope } } };
  let inspection: unknown = ordinary;
  const removed: string[] = [], filters: string[][] = [];
  const server = createServer((req, res) => {
    if (req.method === 'DELETE') { removed.push(req.url!); res.writeHead(204); res.end(); }
    else if (req.url!.startsWith('/containers/json?')) {
      filters.push(JSON.parse(new URL(req.url!, 'http://localhost').searchParams.get('filters')!).label);
      // Hostile/stale listing still must not authorize foreign deletion.
      res.end(JSON.stringify([ordinary, recovery].map(c => ({ Id: c.Id, Labels: c.Config.Labels }))));
    } else res.end(JSON.stringify(inspection));
  });
  const path = `/tmp/retire-scope-${randomUUID()}.sock`;
  await new Promise<void>(resolve => server.listen(path, resolve));
  try {
    const source = createRetirementClient(path), restored = createRetirementClient(path, scope);
    assert.equal((await source.list()).length, 1); assert.equal((await restored.list()).length, 1);
    assert.deepEqual(filters, [['gateway.site-id', 'gateway.release-id'], ['gateway.restore.site-id', 'gateway.restore.release-id', `gateway.runtime-scope=${scope}`]]);
    assert.equal(await restored.retire(id, identity), false);
    inspection = recovery;
    assert.equal(await source.retire(id, identity), false);
    assert.equal(await restored.retire(id, identity), true);
    inspection = { ...recovery, Config: { ...recovery.Config, Labels: { ...recovery.Config.Labels, ...ordinary.Config.Labels } } };
    assert.equal(await restored.retire(id, identity), false);
    assert.equal(await source.retire(id, identity), false);
    assert.equal(removed.length, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
