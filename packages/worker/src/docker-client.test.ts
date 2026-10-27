import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { createDockerEngineClient } from './docker-client.js';

const socketPath = () => process.platform === 'win32' ? `\\\\.\\pipe\\gateway-docker-test-${randomUUID()}` : `/tmp/gateway-docker-test-${randomUUID()}.sock`;
async function withEngine(handler: (request: IncomingMessage, response: ServerResponse) => void, run: (path: string) => Promise<void>) {
  const server = createServer(handler);
  const path = socketPath();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(path, resolve));
  try { await run(path); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
const siteId = randomUUID();
const workspaceId = randomUUID();
const image = `registry.example.com/templates/storefront@sha256:${'a'.repeat(64)}`;
const createBody = {
  Image: image, User: '10001:10001',
  Env: [`SITE_ID=${siteId}`, 'RELEASE_ID=release-1', `NUXT_WORKSPACE_ID=${workspaceId}`, `NUXT_SITE_ID=${siteId}`, 'NUXT_GATEWAY_URL=http://host.docker.internal:3000', `NUXT_SITE_CREDENTIAL=${'a'.repeat(64)}`],
  Labels: { 'gateway.site-id': siteId, 'gateway.release-id': 'release-1' },
  HostConfig: {
    NetworkMode: 'gateway-sites', ReadonlyRootfs: true, Privileged: false,
    CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
    Memory: 512 * 1024 * 1024, NanoCpus: 500_000_000, PidsLimit: 128,
    PortBindings: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '49152' }] },
  },
};
const createPath = '/containers/create?name=gateway-test';
const clientFor = (socketPath: string, options: Record<string, unknown> = {}) => createDockerEngineClient({ socketPath, approvedImages: [image], ...options });

test('sends only approved create, start and forced delete over the private socket', async () => {
  const received: Array<{ method?: string; url?: string; body: string }> = [];
  await withEngine((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      received.push({ method: request.method, url: request.url, body });
      response.writeHead(request.url?.includes('/create?') ? 201 : 204);
      response.end(request.url?.includes('/create?') ? '{"Id":"abc123"}' : '');
    });
  }, async path => {
    const client = clientFor(path);
    assert.deepEqual(await client.request({ method: 'POST', path: createPath, body: createBody }), { Id: 'abc123' });
    assert.deepEqual(await client.request({ method: 'POST', path: '/containers/abc123/start' }), { Id: '' });
    assert.deepEqual(await client.request({ method: 'DELETE', path: '/containers/abc123?force=true' }), { Id: '' });
  });
  assert.deepEqual(received.map(({ method, url }) => [method, url]), [['POST', createPath], ['POST', '/containers/abc123/start'], ['DELETE', '/containers/abc123?force=true']]);
  assert.equal(received[0].body, JSON.stringify(createBody));
  assert.equal(received[1].body, '');
});

test('pulls only an exact allowlisted repository digest through the Docker image API', async () => {
  const received: Array<{ method?: string; url?: string }> = [];
  await withEngine((request, response) => {
    received.push({ method: request.method, url: request.url });
    if (request.url?.startsWith('/images/create?')) { response.writeHead(200); response.end('{"status":"Downloaded"}\n'); }
    else { response.writeHead(200); response.end(JSON.stringify({ RepoDigests: [image] })); }
  }, async path => {
    const client = clientFor(path);
    await client.pull(image);
    await assert.rejects(client.pull('ghcr.io/attacker/other@sha256:' + 'b'.repeat(64)), /Unapproved/);
  });
  assert.deepEqual(received, [
    { method: 'POST', url: `/images/create?fromImage=${encodeURIComponent(image)}` },
    { method: 'GET', url: `/images/${encodeURIComponent(image)}/json` },
  ]);
});

test('rejects a pulled image unless Docker confirms the exact repository digest', async () => {
  await withEngine((_request, response) => { response.writeHead(200); response.end('{"RepoDigests":[]}'); }, async path => {
    await assert.rejects(clientFor(path).pull(image), /digest mismatch/);
  });
});

test('pull wall deadline aborts a progress stream even before its inactivity timeout', async () => {
  await withEngine((_request, response) => {
    const progress = setTimeout(() => { response.writeHead(200); response.write('{"status":"Downloading"}\n'); }, 80);
    response.on('close', () => clearTimeout(progress));
  }, async path => {
    const started = performance.now();
    await assert.rejects(clientFor(path, { timeoutMs: 120 }).pull(image), /timed out/i);
    assert.ok(performance.now() - started < 180, 'pull exceeded the absolute wall deadline');
  });
});

test('pull rejects an HTTP 200 progress error without inspecting or creating a candidate', async () => {
  const requests: string[] = [];
  await withEngine((request, response) => {
    requests.push(request.url!); response.writeHead(200); response.end('{"errorDetail":{"message":"private registry detail"}}\n');
  }, async path => {
    await assert.rejects(clientFor(path).pull(image), /Docker image pull failed/);
  });
  assert.equal(requests.length, 1);
});

test('uses validated path and method scalars when request getters change', async () => {
  const received: Array<{ method?: string; url?: string }> = [];
  await withEngine((request, response) => { received.push({ method: request.method, url: request.url }); response.writeHead(201); response.end('{"Id":"safe-id"}'); }, async path => {
    const client = clientFor(path);
    let pathReads = 0; let methodReads = 0;
    await client.request({ get path() { return ++pathReads === 1 ? createPath : '/containers/safe-id/exec'; }, get method() { return ++methodReads === 1 ? 'POST' : 'DELETE'; }, body: createBody } as never);
  });
  assert.deepEqual(received, [{ method: 'POST', url: createPath }]);
});

test('sends only vetted create bytes under global Object.prototype.toJSON pollution', async () => {
  let bytes = '';
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  try {
    Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, value() { return { HostConfig: { Privileged: true, Binds: 'host:/sock' } }; } });
    await withEngine((request, response) => { request.setEncoding('utf8'); request.on('data', chunk => { bytes += chunk; }); request.on('end', () => { response.writeHead(201); response.end('{"Id":"safe-id"}'); }); }, async path => {
      await clientFor(path).request({ method: 'POST', path: createPath, body: createBody });
    });
  } finally {
    if (previous) Object.defineProperty(Object.prototype, 'toJSON', previous);
    else delete (Object.prototype as { toJSON?: unknown }).toJSON;
  }
  assert.deepEqual(JSON.parse(bytes), createBody);
});

test('rejects inherited serializers, accessors, extra properties and non-loopback bindings', async () => {
  let requests = 0;
  await withEngine((_request, response) => { requests++; response.end(); }, async path => {
    const client = clientFor(path);
    const inherited = Object.assign(Object.create({ toJSON: () => ({ Privileged: true }) }) as object, createBody.HostConfig);
    const getter = { ...createBody.HostConfig };
    Object.defineProperty(getter, 'Privileged', { enumerable: true, get: () => false });
    const extra = { ...createBody.HostConfig, Binds: ['/var/run/docker.sock:/sock'] };
    for (const HostConfig of [inherited, getter, extra, { ...createBody.HostConfig, PortBindings: { '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '49152' }] } }]) {
      await assert.rejects(client.request({ method: 'POST', path: createPath, body: { ...createBody, HostConfig } }), /Invalid Docker request/);
    }
    const labels = { ...createBody.Labels };
    Object.defineProperty(labels, 'toJSON', { value: () => ({ 'gateway.site-id': siteId }) });
    await assert.rejects(client.request({ method: 'POST', path: createPath, body: { ...createBody, Labels: labels } }), /Invalid Docker request/);
    const env = [...createBody.Env];
    Object.defineProperty(env, '0', { get: () => `SITE_ID=${siteId}` });
    await assert.rejects(client.request({ method: 'POST', path: createPath, body: { ...createBody, Env: env } }), /Invalid Docker request/);
    await assert.rejects(client.request({ method: 'POST', path: createPath, body: { ...createBody, Image: `sha256:${'b'.repeat(64)}` } }), /Invalid Docker request/);
  });
  assert.equal(requests, 0);
});

test('only starts or deletes IDs returned by successful creates in the same client', async () => {
  const received: string[] = [];
  await withEngine((request, response) => { received.push(request.url!); response.writeHead(request.url?.includes('/create?') ? 201 : 204); response.end(request.url?.includes('/create?') ? '{"Id":"owned-id"}' : ''); }, async path => {
    const first = clientFor(path); const other = clientFor(path);
    for (const client of [first, other]) {
      await assert.rejects(client.request({ method: 'POST', path: '/containers/arbitrary-id/start' }), /Invalid Docker request/);
      await assert.rejects(client.request({ method: 'DELETE', path: '/containers/arbitrary-id?force=true' }), /Invalid Docker request/);
    }
    await first.request({ method: 'POST', path: createPath, body: createBody });
    await assert.rejects(other.request({ method: 'DELETE', path: '/containers/owned-id?force=true' }), /Invalid Docker request/);
    await first.request({ method: 'POST', path: '/containers/owned-id/start' });
    await first.request({ method: 'DELETE', path: '/containers/owned-id?force=true' });
    await assert.rejects(first.request({ method: 'DELETE', path: '/containers/owned-id?force=true' }), /Invalid Docker request/);
  });
  assert.deepEqual(received, [createPath, '/containers/owned-id/start', '/containers/owned-id?force=true']);
});

test('rejects unauthorized paths, methods and unsafe create options without sending', async () => {
  let requests = 0;
  await withEngine((_request, response) => { requests++; response.end(); }, async path => {
    const client = clientFor(path);
    const invalid = [
      { method: 'POST', path: '/containers/create?name=bad%2F..', body: createBody },
      { method: 'POST', path: '/containers/create?name=good&image=evil', body: createBody },
      { method: 'POST', path: '/containers/a/exec' }, { method: 'DELETE', path: '/containers/a?force=false' },
      { method: 'POST', path: '/images/create?fromImage=evil' }, { method: 'GET', path: '/containers/a/json' },
      { method: 'POST', path: createPath, body: { ...createBody, Cmd: ['sh'] } },
      { method: 'POST', path: createPath, body: { ...createBody, Env: [...createBody.Env, 'BIND=/sock'] } },
      { method: 'POST', path: createPath, body: { ...createBody, HostConfig: { ...createBody.HostConfig, NetworkMode: 'host' } } },
    ];
    for (const request of invalid) await assert.rejects(client.request(request as never), /Invalid Docker request/);
  });
  assert.equal(requests, 0);
});

test('does not expose engine error body or socket details', async () => {
  await withEngine((request, response) => { response.writeHead(request.url?.includes('/create?') ? 201 : 500); response.end(request.url?.includes('/create?') ? '{"Id":"a"}' : '{"message":"secret-password"}'); }, async path => {
    const client = clientFor(path);
    await client.request({ method: 'POST', path: createPath, body: createBody });
    await assert.rejects(client.request({ method: 'POST', path: '/containers/a/start' }), error => {
      assert.match(String(error), /Docker Engine request failed \(500\)/);
      assert.doesNotMatch(String(error), /secret-password|gateway-docker-test/);
      return true;
    });
  });
});

test('times out a hanging engine request', async () => {
  await withEngine((request, response) => { if (request.url?.includes('/create?')) { response.writeHead(201); response.end('{"Id":"a"}'); } }, async path => {
    const client = clientFor(path, { timeoutMs: 40 });
    await client.request({ method: 'POST', path: createPath, body: createBody });
    await assert.rejects(client.request({ method: 'POST', path: '/containers/a/start' }), /Docker Engine request timed out/);
  });
});

test('rejects oversized responses without exposing response content', async () => {
  await withEngine((_request, response) => { response.writeHead(201); response.end(JSON.stringify({ Id: 'a'.repeat(512), secret: 'engine-secret' })); }, async path => {
    const client = clientFor(path, { maxResponseBytes: 64 });
    await assert.rejects(client.request({ method: 'POST', path: createPath, body: createBody }), /Docker Engine response too large/);
  });
});
