import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { test } from 'node:test';
import { createTrafficProxy } from './index.js';

function fetchHost(port: number, host: string): Promise<{ status: number; body: string; location?: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, headers: { host } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, ...(res.headers.location ? { location: res.headers.location } : {}) }));
    });
    req.on('error', reject); req.end();
  });
}

function fetchPath(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject); req.end();
  });
}

test('traffic proxy forwards from the durable route snapshot without control or worker state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-traffic-'));
  const state = join(dir, 'routes.json');
  const upstream = createServer((_request, response) => response.end('published'));
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;
  await writeFile(state, JSON.stringify({ routes: [{ siteId: 'site-1', revision: 3, port: upstreamPort, host: 'site.example.test', redirectHosts: ['site.example.test', 'www.site.example.test'], token: 'token', containerId: 'container', releaseId: 'release-3' }], previous: [] }));
  const proxy = createTrafficProxy(state); await proxy.listen(0);
  try {
    assert.deepEqual(await fetchHost(proxy.port(), 'site.example.test'), { status: 200, body: 'published' });
    assert.deepEqual(await fetchHost(proxy.port(), 'www.site.example.test'), { status: 301, body: '', location: 'https://site.example.test/' });
    assert.equal((await fetchHost(proxy.port(), 'unknown.example.test')).status, 404);
    assert.deepEqual(await fetchPath(proxy.port(), '/healthz'), { status: 200, body: '{"status":"ok","routeCount":1}' });
  } finally { await proxy.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});
