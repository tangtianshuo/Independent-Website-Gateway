import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createDockerCandidateAdapter } from './docker.js';
import { failPublishOperation } from './operations.js';

const siteId = randomUUID();
const releaseId = randomUUID();
const digest = `sha256:${'a'.repeat(64)}`;
const otherDigest = `sha256:${'b'.repeat(64)}`;
const leaseUntil = new Date(Date.now() + 60_000);
const repository = 'registry.example.com/templates/storefront';
const image = { repository, digest };
const config = {
  network: 'gateway-sites',
  images: [image],
};
const runtime = { workspaceId: randomUUID(), credential: 'a'.repeat(64), gatewayUrl: 'http://host.docker.internal:3000', hostPort: 49152 };

function client() {
  const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  return {
    requests,
    request: async (request: { method: string; path: string; body?: Record<string, unknown> }) => {
      requests.push(request);
      return { Id: 'docker-generated-id' };
    },
  };
}

test('injects site-scoped Nuxt configuration into an approved local candidate', async () => {
  const docker = client();
  const adapter = createDockerCandidateAdapter(docker, { network: 'gateway-sites', images: [{ repository: 'local', digest }] });
  await adapter.startCandidate({ siteId, releaseId, image: { repository: 'local', digest }, ...runtime });
  const body = docker.requests[0].body!;
  assert.equal(body.Image, digest);
  assert.match(JSON.stringify(body.Env), /NUXT_GATEWAY_URL=http:\/\/host.docker.internal:3000/);
  assert.match(JSON.stringify(body.Env), /NUXT_SITE_CREDENTIAL=/);
  assert.deepEqual((body.HostConfig as Record<string, unknown>).PortBindings, { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '49152' }] });
});

test('creates and starts an approved immutable candidate with fixed isolation', async () => {
  const docker = client();
  const adapter = createDockerCandidateAdapter(docker, config);
  const id = await adapter.startCandidate({ siteId, releaseId, image, ...runtime });
  assert.equal(id, 'docker-generated-id');
  assert.equal(docker.requests.length, 2);
  const [create, start] = docker.requests;
  assert.equal(create.method, 'POST');
  assert.match(create.path, /^\/containers\/create\?name=gateway-[0-9a-f-]+-[0-9a-f-]+-[0-9a-f-]+$/);
  assert.equal(start.path, '/containers/docker-generated-id/start');
  assert.equal(start.method, 'POST');
  assert.deepEqual(create.body, {
    Image: `${repository}@${digest}`,
    User: '10001:10001',
    Env: [`SITE_ID=${siteId}`, `RELEASE_ID=${releaseId}`, `NUXT_WORKSPACE_ID=${runtime.workspaceId}`, `NUXT_SITE_ID=${siteId}`, `NUXT_GATEWAY_URL=${runtime.gatewayUrl}`, `NUXT_SITE_CREDENTIAL=${runtime.credential}`],
    Labels: { 'gateway.site-id': siteId, 'gateway.release-id': releaseId },
    HostConfig: {
      NetworkMode: 'gateway-sites', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'], Memory: 512 * 1024 * 1024, NanoCpus: 500_000_000, PidsLimit: 128,
      PortBindings: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '49152' }] },
    },
  });
});

test('rejects valid-looking but unapproved repository and digest pairs before Docker calls', async () => {
  const docker = client();
  const adapter = createDockerCandidateAdapter(docker, config);
  for (const rejected of [
    { repository, digest: otherDigest },
    { repository: 'registry.example.com/templates/other', digest },
    { repository: 'registry.example.com/templates/storefront:latest', digest },
    { repository, digest: 'latest' },
  ]) {
    await assert.rejects(adapter.startCandidate({ siteId, releaseId, image: rejected, ...runtime }), /image/i);
  }
  assert.equal(docker.requests.length, 0);
});

test('rejects invalid runtime fields and ignores caller-supplied Docker options', async () => {
  const docker = client();
  const adapter = createDockerCandidateAdapter(docker, config);
  await assert.rejects(adapter.startCandidate({ siteId: 'other/../../', releaseId, image, ...runtime }), /site/i);
  for (const bad of [{ hostPort: 80 }, { credential: 'x\nBinds=/sock' }, { gatewayUrl: 'http://evil.example:3000' }, { workspaceId: 'invalid' }]) {
    await assert.rejects(adapter.startCandidate({ siteId, releaseId, image, ...runtime, ...bad }), /candidate|runtime|port|credential|workspace|gateway/i);
  }
  assert.equal(docker.requests.length, 0);
  await adapter.startCandidate({ siteId, releaseId, image, ...runtime, name: 'attacker', HostConfig: { Privileged: true, Binds: ['/var/run/docker.sock:/var/run/docker.sock'] }, Cmd: ['sh'] } as never);
  assert.equal('Cmd' in docker.requests[0].body!, false);
  assert.equal('Binds' in (docker.requests[0].body!.HostConfig as object), false);
});

test('removes a created candidate when Docker fails to start it', async () => {
  const requests: Array<{ method: string; path: string }> = [];
  const docker = {
    requests,
    request: async (request: { method: string; path: string }) => {
      requests.push(request);
      if (request.path.endsWith('/start')) throw new Error('start failed');
      return { Id: 'created-candidate' };
    },
  };
  const adapter = createDockerCandidateAdapter(docker, config);
  await assert.rejects(adapter.startCandidate({ siteId, releaseId, image, ...runtime }), /start failed/);
  assert.deepEqual(requests.map(({ method, path }) => [method, path]), [
    ['POST', requests[0].path], ['POST', '/containers/created-candidate/start'], ['DELETE', '/containers/created-candidate?force=true'],
  ]);
});

test('preserves start error and identifies residual candidate when cleanup also fails', async () => {
  const startError = new Error('start failed');
  const cleanupError = new Error('delete failed');
  const paths: string[] = [];
  const docker = {
    request: async ({ path }: { path: string }) => {
      paths.push(path);
      if (path.endsWith('/start')) throw startError;
      if (path.includes('force=true')) throw cleanupError;
      return { Id: 'created-candidate' };
    },
  };
  const adapter = createDockerCandidateAdapter(docker, config);
  await assert.rejects(adapter.startCandidate({ siteId, releaseId, image, ...runtime }), error => {
    assert.equal((error as Error & { cause?: unknown }).cause, startError);
    assert.match(String(error), /created-candidate/);
    assert.equal((error as Error & { cleanupError?: unknown }).cleanupError, cleanupError);
    return true;
  });
  assert.deepEqual(paths.slice(1), ['/containers/created-candidate/start', '/containers/created-candidate?force=true']);
});

test('records a bounded failure only while the worker owns the lease', async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const pool = { query: async (text: string, values?: unknown[]) => { calls.push({ text, values }); return { rowCount: 1 }; } };
  const changed = await failPublishOperation(pool as never, { operationId: randomUUID(), workerId: 'worker-a', attempts: 1, leaseUntil, failureCode: 'CANDIDATE_START_FAILED' });
  assert.equal(changed, true);
  assert.deepEqual(calls[0].values?.slice(0, 2), ['failed', 'CANDIDATE_START_FAILED']);
  assert.match(calls[0].text, /"leaseOwner" = \$4/);
});

test('does not overwrite the operation after the lease was taken by another worker', async () => {
  const pool = { query: async () => ({ rowCount: 0 }) };
  assert.equal(await failPublishOperation(pool as never, { operationId: randomUUID(), workerId: 'worker-a', attempts: 1, leaseUntil, failureCode: 'CANDIDATE_START_FAILED' }), false);
});

test('rejects arbitrary failure messages before touching the database', async () => {
  let called = false;
  const pool = { query: async () => { called = true; return { rowCount: 1 }; } };
  await assert.rejects(failPublishOperation(pool as never, { operationId: randomUUID(), workerId: 'worker-a', attempts: 1, leaseUntil, failureCode: 'secret=leaked' } as never), /failure code/i);
  assert.equal(called, false);
});

test('rejects unsafe trusted configuration before any Docker request', () => {
  const docker = client();
  assert.throws(() => createDockerCandidateAdapter(docker, { ...config, network: 'host' }), /network/i);
  assert.throws(() => createDockerCandidateAdapter(docker, { ...config, images: [{ repository, digest: 'latest' }] }), /image/i);
  assert.equal(docker.requests.length, 0);
});
