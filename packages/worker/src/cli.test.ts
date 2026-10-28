import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('direct worker CLI executes startup and rejects missing configuration', () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./index.js', import.meta.url))], {
    env: { ...process.env, DATABASE_URL: '', GATEWAY_CONTROL_URL: '' }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(run.status, 1, 'CLI must execute runWorker rather than exit successfully without starting');
  assert.match(run.stderr, /Invalid worker configuration/);
});
