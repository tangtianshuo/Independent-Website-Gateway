import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { requireDatabaseRuntimeScope, runtimeOwnership } from './runtime-scope.js';
import { inspectRoute } from './index.js';

const scope = 'restore-' + 'a'.repeat(24);
function database(name: string, scopes?: string[]) {
  return { query: async (sql: string) => ({ rows: sql.includes('current_database') ? [{ database: name, marker: scopes ? 'GatewayRuntimeScope' : null }] : scopes!.map(scope => ({ scope })) }) } as never;
}
test('ordinary DB defaults survive while restored and renamed clones fail closed without their persisted scope', async () => {
  assert.equal(await requireDatabaseRuntimeScope(database('ordinary')), undefined);
  await assert.rejects(requireDatabaseRuntimeScope(database('platform_restore_' + 'a'.repeat(24))), /scope_required/);
  await assert.rejects(requireDatabaseRuntimeScope(database('ordinary'), scope), /scope_required/);
  for (const name of ['platform_restore_' + 'a'.repeat(24), 'renamed_clone']) {
    await assert.rejects(requireDatabaseRuntimeScope(database(name, [scope])), /scope_mismatch/);
    await assert.rejects(requireDatabaseRuntimeScope(database(name, [scope]), 'restore-' + 'b'.repeat(24)), /scope_mismatch/);
    assert.equal(await requireDatabaseRuntimeScope(database(name, [scope]), scope), scope);
  }
  await assert.rejects(requireDatabaseRuntimeScope(database('clone', []), scope), /scope_mismatch/);
  await assert.rejects(requireDatabaseRuntimeScope(database('clone', [scope, scope]), scope), /scope_mismatch/);
});

test('source and recovery route inspection reject each other and mixed ownership even for identical logical IDs', async () => {
  const route = { siteId: randomUUID(), releaseId: 'r1', revision: 1, host: 'site.test', token: 'token', port: 49152, containerId: 'a'.repeat(64) };
  let labels: Record<string, string> = {};
  const path = `/tmp/scope-${randomUUID()}.sock`;
  const server = createServer((_request, response) => response.end(JSON.stringify({ Id: route.containerId, State: { Running: true }, Config: { Labels: labels }, NetworkSettings: { Ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '49152' }] } } })));
  await new Promise<void>(resolve => server.listen(path, resolve));
  try {
    labels = runtimeOwnership().labels(route.siteId, route.releaseId);
    assert.equal(await inspectRoute(path, route), true);
    assert.equal(await inspectRoute(path, route, scope), false);
    labels = runtimeOwnership(scope).labels(route.siteId, route.releaseId);
    assert.equal(await inspectRoute(path, route), false);
    assert.equal(await inspectRoute(path, route, scope), true);
    assert.equal(await inspectRoute(path, route, 'restore-' + 'b'.repeat(24)), false);
    labels = { ...labels, ...runtimeOwnership().labels(route.siteId, route.releaseId) };
    assert.equal(await inspectRoute(path, route), false);
    assert.equal(await inspectRoute(path, route, scope), false);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
