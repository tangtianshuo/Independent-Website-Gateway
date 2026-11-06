import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { backupRouteState, restoreRouteState } from './state.js';

const state = JSON.stringify({ routes: [{ siteId: 'site-1', revision: 3, port: 3000, host: 'site.example.test', token: 'token', containerId: 'container', releaseId: 'release-3' }], previous: [] });

test('route state backup and restore validate and preserve an atomic snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-route-state-'));
  try {
    const source = join(directory, 'routes.json'); const backup = join(directory, 'backup', 'routes.json'); const restored = join(directory, 'restored', 'routes.json');
    await writeFile(source, state, { mode: 0o600 });
    await backupRouteState(source, backup);
    await restoreRouteState(backup, restored);
    assert.equal(await readFile(restored, 'utf8'), state);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('route state backup refuses malformed snapshots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-route-state-invalid-'));
  try {
    const source = join(directory, 'routes.json');
    await writeFile(source, JSON.stringify({ routes: [], previous: [{ siteId: 'site', port: 80 }] }));
    await assert.rejects(() => backupRouteState(source, join(directory, 'backup.json')), /invalid route state/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
