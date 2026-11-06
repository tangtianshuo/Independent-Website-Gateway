import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('direct worker CLI executes startup and rejects missing configuration', () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./index.js', import.meta.url))], {
    env: { ...process.env, DATABASE_URL: '', GATEWAY_CONTROL_URL: '' }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(run.status, 1, 'CLI must execute runWorker rather than exit successfully without starting');
  assert.match(run.stderr, /Invalid worker configuration/);
});


test('worker starts while independent traffic owns the configured public port', { skip: !process.env.GATEWAY_TEST_DATABASE_URL, timeout: 10000 }, async () => {
  const traffic = createServer();
  await new Promise<void>(resolve => traffic.listen(0, '127.0.0.1', resolve));
  const dir = await mkdtemp(join(tmpdir(), 'gateway-worker-'));
  // The process startup probe must never claim another integration fixture's queue.
  const database = new URL(process.env.GATEWAY_TEST_DATABASE_URL!);
  database.searchParams.set('options', '-c default_transaction_read_only=on');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./index.js', import.meta.url))], {
    env: { ...process.env, DATABASE_URL: database.href, DOCKER_SOCKET_PATH: join(dir, 'absent-docker.sock'),
      GATEWAY_CONTROL_URL: 'http://host.docker.internal:18183',
      GATEWAY_PROXY_PORT: String((traffic.address() as { port: number }).port),
      GATEWAY_TRAFFIC_EXTERNAL: '', GATEWAY_ROUTE_STATE_PATH: join(dir, 'routes.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('Gateway worker started')) resolve(); });
      child.stderr.on('data', chunk => { output += chunk; if (output.includes('EADDRINUSE')) reject(new Error(output)); });
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Worker exited (${code}): ${output}`)));
    });
    const stopped = new Promise<number | null>(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    assert.equal(await stopped, 0, output);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await new Promise<void>(resolve => traffic.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
