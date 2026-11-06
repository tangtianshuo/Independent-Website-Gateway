import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { artifactSnapshotPath, ensureArtifactReadable } from './artifacts.js';

const siteId = 'site-1', releaseId = 'release-1', bytes = 'published artifact';
const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

test('legacy artifacts become runtime-readable without exposing the storage directory or changing bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-artifact-'));
  const path = artifactSnapshotPath(directory, siteId, releaseId);
  try {
    await chmod(directory, 0o755); await writeFile(path, bytes, { mode: 0o600 });
    assert.equal(await ensureArtifactReadable(directory, siteId, releaseId, checksum), path);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o444);
    assert.equal(await readFile(path, 'utf8'), bytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('artifact permission reconciliation refuses changed bytes and symlinks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-artifact-'));
  const path = artifactSnapshotPath(directory, siteId, releaseId), external = join(directory, 'external');
  try {
    await writeFile(path, 'changed bytes', { mode: 0o600 });
    await assert.rejects(ensureArtifactReadable(directory, siteId, releaseId, checksum), /checksum/);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await rm(path); await writeFile(external, bytes, { mode: 0o600 }); await symlink(external, path);
    await assert.rejects(ensureArtifactReadable(directory, siteId, releaseId, checksum));
    assert.equal((await stat(external)).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Linux root-owned legacy artifacts can be read by runtime UID 10001 only through the sealed file mount', { skip: process.env.GATEWAY_TEST_DOCKER !== '1', timeout: 30000 }, () => {
  const volume = `gateway-artifact-test-${randomUUID()}`;
  const module = fileURLToPath(new URL('./artifacts.js', import.meta.url));
  const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8', timeout: 10000 });
  const check = (result: ReturnType<typeof docker>) => { assert.equal(result.status, 0, result.stderr); return result.stdout; };
  const root = (script: string) => docker('run', '--rm', '--network', 'none', '--mount', `type=volume,source=${volume},target=/fixture`, '--mount', `type=bind,source=${module},target=/artifacts.mjs,readonly`, 'node:22-slim', 'node', '--input-type=module', '-e', script);
  try {
    check(docker('volume', 'create', volume));
    const filename = artifactSnapshotPath('/fixture/private', siteId, releaseId);
    check(root(`import fs from 'node:fs/promises'; await fs.mkdir('/fixture/private', { mode: 0o700 }); await fs.writeFile(${JSON.stringify(filename)}, ${JSON.stringify(bytes)}, { mode: 0o600 });`));
    const mount = JSON.parse(check(docker('volume', 'inspect', volume)))[0].Mountpoint;
    const fileMount = `type=bind,source=${mount}/private/${filename.split('/').pop()},target=/published.json,readonly`;
    const read = () => docker('run', '--rm', '--network', 'none', '--user', '10001:10001', '--mount', fileMount, 'node:22-slim', 'node', '-e', "process.stdout.write(require('fs').readFileSync('/published.json','utf8'))");
    const before = read(); assert.equal(before.status, 1); assert.match(before.stderr, /EACCES/);
    check(root(`import { ensureArtifactReadable } from '/artifacts.mjs'; await ensureArtifactReadable('/fixture/private', ${JSON.stringify(siteId)}, ${JSON.stringify(releaseId)}, ${JSON.stringify(checksum)});`));
    assert.equal(check(read()), bytes);
    const privateRead = docker('run', '--rm', '--network', 'none', '--user', '10002:10002', '--mount', `type=volume,source=${volume},target=/fixture,readonly`, 'node:22-slim', 'node', '-e', `require('fs').readFileSync(${JSON.stringify(filename)})`);
    assert.equal(privateRead.status, 1); assert.match(privateRead.stderr, /EACCES/);
    const write = docker('run', '--rm', '--network', 'none', '--user', '10001:10001', '--mount', fileMount, 'node:22-slim', 'node', '-e', "require('fs').writeFileSync('/published.json','changed')");
    assert.equal(write.status, 1); assert.match(write.stderr, /EACCES|EROFS/);
    assert.equal(check(read()), bytes);
  } finally { check(docker('volume', 'rm', volume)); }
});
