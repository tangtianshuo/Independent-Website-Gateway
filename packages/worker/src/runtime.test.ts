import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalRouter, checkCandidate } from './runtime.js';

const siteId = randomUUID();
function fetchHost(port: number, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, headers: { Host: host } }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on('error', reject); request.end();
  });
}

async function upstream(body: string) {
  const server = createServer((_request, response) => { response.end(body); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as { port: number }).port,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('local router switches by verified host and restores only matching token', async () => {
  const old = await upstream('old');
  const router = createLocalRouter();
  await router.listen(0);
  const proxyPort = router.port();
  try {
    await router.applyRoute(siteId, 1, old.port, 'site.example.test', 'old-token', 'old-container', 'old-release');
    const previous = await router.readRoute(siteId);
    assert.equal((await fetchHost(proxyPort, 'site.example.test')).status, 200);
    assert.equal((await fetchHost(proxyPort, 'foreign.example.test')).status, 404);
    await router.applyRoute(siteId, 2, 49999, 'site.example.test', 'new-token', 'new-container', 'new-release');
    assert.equal(await router.restoreRoute(siteId, 'old-token', previous), false);
    assert.equal(await router.restoreRoute(siteId, 'new-token', previous), true);
    assert.equal((await fetchHost(proxyPort, 'site.example.test')).body, 'old');
  } finally { await router.close(); await old.close(); }
});

test('switch and token-guarded rollback persist atomically across restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-route-'));
  const state = join(dir, 'routes.json');
  const old = await upstream('old');
  const next = await upstream('next');
  const active = async () => [{ siteId, releaseId: 'old-release', routeRevision: 1 }];
  const valid = async () => true;
  const first = createLocalRouter(state);
  try {
    await first.applyRoute(siteId, 1, old.port, 'site.example.test', 'old-token', 'old-container', 'old-release');
    const previous = await first.readRoute(siteId);
    await first.applyRoute(siteId, 2, next.port, 'site.example.test', 'new-token', 'new-container', 'new-release');
    assert.equal(await first.restoreRoute(siteId, 'old-token', previous), false);
    assert.equal(JSON.parse(await readFile(state, 'utf8')).routes[0].token, 'new-token');
    const recovered = createLocalRouter(state);
    await recovered.recover(active, valid);
    await recovered.listen(0);
    try {
      assert.equal((await fetchHost(recovered.port(), 'site.example.test')).body, 'old');
      assert.equal(await recovered.readRoute(siteId)?.then(route => route?.token), 'old-token');
    } finally { await recovered.close(); }
    assert.equal(await first.restoreRoute(siteId, 'new-token', previous), true);
    assert.equal(JSON.parse(await readFile(state, 'utf8')).routes[0].token, 'old-token');
  } finally { await old.close(); await next.close(); await rm(dir, { recursive: true, force: true }); }
});

test('restart only restores database-active route when container and port still match', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-route-'));
  const state = join(dir, 'routes.json');
  const old = await upstream('old');
  const next = await upstream('next');
  try {
    const writer = createLocalRouter(state);
    await writer.applyRoute(siteId, 1, old.port, 'site.example.test', 'old-token', 'old-container', 'old-release');
    await writer.applyRoute(siteId, 2, next.port, 'site.example.test', 'new-token', 'new-container', 'new-release');
    const restore = async (active: { siteId: string; releaseId: string; routeRevision: number }[], valid: (route: { containerId?: string; port: number }) => Promise<boolean>) => {
      const router = createLocalRouter(state);
      await router.recover(async () => active, valid);
      return router.readRoute(siteId);
    };
    assert.equal((await restore([{ siteId, releaseId: 'new-release', routeRevision: 2 }], async route => route.containerId === 'new-container' && route.port === next.port))?.token, 'new-token');
    assert.equal(await restore([{ siteId, releaseId: 'new-release', routeRevision: 2 }], async () => false), undefined);
    assert.equal(await restore([], async () => true), undefined);
  } finally { await old.close(); await next.close(); await rm(dir, { recursive: true, force: true }); }
});

test('failed snapshot write leaves the old in-memory route intact', async () => {
  const old = await upstream('old');
  const router = createLocalRouter(join(tmpdir(), `missing-${randomUUID()}`, 'routes.json'));
  await router.listen(0);
  try {
    await assert.rejects(router.applyRoute(siteId, 2, old.port, 'site.example.test', 'new-token', 'new-container', 'new-release'));
    assert.equal(await router.readRoute(siteId), undefined);
    assert.equal((await fetchHost(router.port(), 'site.example.test')).status, 404);
  } finally { await router.close(); await old.close(); }
});

test('invalidated container identity cannot forward to a reused port', async () => {
  const target = await upstream('wrong-service');
  let valid = true;
  const router = createLocalRouter(undefined, async () => valid);
  await router.listen(0);
  try {
    await router.applyRoute(siteId, 1, target.port, 'site.example.test', 'old-token');
    valid = false;
    assert.equal((await fetchHost(router.port(), 'site.example.test')).status, 502);
  } finally { await router.close(); await target.close(); }
});

test('candidate health uses the image health endpoint instead of the homepage', async () => {
  const server = createServer((request, response) => {
    response.writeHead(request.url === '/healthz' ? 200 : 404);
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    assert.equal(await checkCandidate(port, 'site.example.test'), true);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('candidate health rejects failed responses', async () => {
  const server = createServer((_request, response) => { response.writeHead(503); response.end('unhealthy'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { assert.equal(await checkCandidate((server.address() as { port: number }).port, 'site.example.test'), false); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('representative Host homepage requires a direct 200 even when healthz is ready', async () => {
  let homepageStatus = 404;
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(`${request.headers.host} ${request.url}`);
    response.writeHead(request.url === '/healthz' ? 200 : homepageStatus, homepageStatus === 301 && request.url === '/' ? { Location: '/home' } : {});
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    assert.equal(await checkCandidate(port, 'site.example.test'), true);
    assert.equal(await checkCandidate(port, 'site.example.test', '/'), false);
    homepageStatus = 301;
    assert.equal(await checkCandidate(port, 'site.example.test', '/'), false);
    homepageStatus = 200;
    assert.equal(await checkCandidate(port, 'site.example.test', '/'), true);
    assert.deepEqual(paths, ['site.example.test /healthz', 'site.example.test /', 'site.example.test /', 'site.example.test /']);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('route verification checks the proxied homepage, not just healthz', async () => {
  let homepageStatus = 404;
  const target = createServer((request, response) => {
    response.writeHead(request.url === '/healthz' ? 200 : homepageStatus);
    response.end();
  });
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
  const router = createLocalRouter();
  await router.listen(0);
  try {
    await router.applyRoute(siteId, 1, (target.address() as { port: number }).port, 'site.example.test', 'token');
    assert.equal(await router.verifyRoute(siteId, 1, 'site.example.test'), false);
    homepageStatus = 301;
    assert.equal(await router.verifyRoute(siteId, 1, 'site.example.test'), false);
    homepageStatus = 200;
    assert.equal(await router.verifyRoute(siteId, 1, 'site.example.test'), true);
  } finally { await router.close(); target.closeAllConnections(); await new Promise<void>(resolve => target.close(() => resolve())); }
});

test('restart does not restore an active container whose homepage is unavailable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-route-'));
  const state = join(dir, 'routes.json');
  let homepageStatus = 404;
  const target = createServer((request, response) => {
    response.writeHead(request.url === '/healthz' ? 200 : homepageStatus);
    response.end();
  });
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
  try {
    const writer = createLocalRouter(state);
    await writer.applyRoute(siteId, 1, (target.address() as { port: number }).port, 'site.example.test', 'token', 'container', 'release');
    const restore = async () => {
      const router = createLocalRouter(state);
      await router.recover(async () => [{ siteId, releaseId: 'release', routeRevision: 1 }], async () => true);
      return router.readRoute(siteId);
    };
    assert.equal(await restore(), undefined);
    homepageStatus = 301;
    assert.equal(await restore(), undefined);
    homepageStatus = 200;
    assert.equal((await restore())?.token, 'token');
  } finally { target.closeAllConnections(); await new Promise<void>(resolve => target.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});


test('retirement protection retains the previous route after restart and replaces it on the next switch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-protection-'));
  const state = join(dir, 'routes.json');
  const target = await upstream('active');
  try {
    const writer = createLocalRouter(state);
    await writer.applyRoute(siteId, 1, target.port, 'site.example.test', 'one', 'first', 'release-1');
    await writer.applyRoute(siteId, 2, target.port, 'site.example.test', 'two', 'second', 'release-2');
    const recovered = createLocalRouter(state);
    await recovered.recover(async () => [{ siteId, releaseId: 'release-2', routeRevision: 2 }], async () => true);
    assert.deepEqual(recovered.protectedRoutes().map(route => route.containerId), ['second', 'first']);
    recovered.protectedRoutes()[0].containerId = 'tampered';
    assert.equal((await recovered.readRoute(siteId))?.containerId, 'second');
    await recovered.applyRoute(siteId, 3, target.port, 'site.example.test', 'three', 'third', 'release-3');
    assert.deepEqual(recovered.protectedRoutes().map(route => route.containerId), ['third', 'second']);
  } finally { await target.close(); await rm(dir, { recursive: true, force: true }); }
});
