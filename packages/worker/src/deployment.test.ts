import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deployCandidate } from './deployment.js';

const claim = {
  id: 'operation-1', siteId: 'site-1', workspaceId: 'workspace-1', releaseId: 'release-2',
  desiredRevision: 2, leaseOwner: 'worker-1', leaseUntil: new Date('2030-01-01'), attempts: 3,
};
const image = { repository: 'registry.example.com/templates/storefront', digest: `sha256:${'a'.repeat(64)}` };
const pending = { status: 'pending', desiredRevision: 2, leaseOwner: claim.leaseOwner, leaseUntil: claim.leaseUntil, attempts: claim.attempts, active: null };

function setup() {
  const calls: string[] = [];
  let route = 'previous-route';
  let routeToken: string | null = null;
  const dependencies = {
    getRepresentativeHost: async (siteId: string) => { calls.push(`host:${siteId}`); return 'shop.example.com'; },
    readRoute: async (siteId: string) => { calls.push(`read:${siteId}`); return route; },
    readDeploymentState: async (_operationId: string) => { calls.push('state'); return pending as {
      status: string; desiredRevision: number; leaseOwner: string | null; leaseUntil: Date | null; attempts: number;
      active: null | { releaseId: string; imageDigest: string; routeRevision: number };
    }; },
    startCandidate: async (input: unknown) => { assert.deepEqual(input, { siteId: claim.siteId, releaseId: claim.releaseId, image }); calls.push('start'); return 'candidate-2'; },
    removeCandidate: async (_containerId: string) => { calls.push('remove'); },
    waitHealthy: async (containerId: string) => { assert.equal(containerId, 'candidate-2'); calls.push('healthy'); return true; },
    checkRepresentativeHost: async (containerId: string, host: string) => { assert.equal(containerId, 'candidate-2'); assert.equal(host, 'shop.example.com'); calls.push('candidate-host'); return true; },
    applyRoute: async (siteId: string, revision: number, containerId: string, host: string, token: string) => {
      assert.deepEqual([siteId, revision, containerId, host], [claim.siteId, 2, 'candidate-2', 'shop.example.com']);
      assert.match(token, /^operation-1:3:[0-9a-f-]{36}$/);
      route = containerId; routeToken = token; calls.push('apply');
    },
    verifyRoute: async (siteId: string, revision: number, host: string) => {
      assert.deepEqual([siteId, revision, host], [claim.siteId, 2, 'shop.example.com']); calls.push('verify'); return true;
    },
    restoreRoute: async (siteId: string, token: string, previous: string) => {
      assert.deepEqual([siteId, previous], [claim.siteId, 'previous-route']); calls.push('restore');
      if (routeToken !== token) return false;
      route = previous; routeToken = null; return true;
    },
    finalizeAfterRouteVerification: async (input: unknown) => {
      assert.deepEqual(input, { operationId: claim.id, workerId: claim.leaseOwner, attempts: claim.attempts, leaseUntil: claim.leaseUntil, imageDigest: image.digest, imageRepository: image.repository });
      calls.push('finalize'); return true;
    },
    failPublishOperation: async (input: { failureCode: string }) => { calls.push(`fail:${input.failureCode}`); return true; },
  };
  return { calls, dependencies, currentRoute: () => route, switchTo: (token: string) => { route = 'other-candidate'; routeToken = token; } };
}

test('verifies candidate health and representative Host before switching, then verifies route before finalizing', async () => {
  const { calls, dependencies } = setup();
  assert.equal(await deployCandidate(claim, image, dependencies), true);
  assert.deepEqual(calls, ['host:site-1', 'start', 'healthy', 'candidate-host', 'read:site-1', 'state', 'apply', 'verify', 'finalize']);
});

test('unhealthy candidate leaves old route and active tuple untouched', async () => {
  const { calls, dependencies } = setup();
  dependencies.waitHealthy = async () => { calls.push('healthy'); return false; };
  await assert.rejects(deployCandidate(claim, image, dependencies), /healthy/i);
  assert.deepEqual(calls, ['host:site-1', 'start', 'healthy', 'remove', 'fail:CANDIDATE_UNHEALTHY']);
});

test('failed representative Host check does not switch route', async () => {
  const { calls, dependencies } = setup();
  dependencies.checkRepresentativeHost = async () => { calls.push('candidate-host'); return false; };
  await assert.rejects(deployCandidate(claim, image, dependencies), /Host/i);
  assert.deepEqual(calls, ['host:site-1', 'start', 'healthy', 'candidate-host', 'remove', 'fail:CANDIDATE_UNHEALTHY']);
});

test('route verification failure restores old route before marking failure', async () => {
  const { calls, dependencies, currentRoute } = setup();
  dependencies.verifyRoute = async () => { calls.push('verify'); return false; };
  await assert.rejects(deployCandidate(claim, image, dependencies), /route/i);
  assert.equal(currentRoute(), 'previous-route');
  assert.deepEqual(calls, ['host:site-1', 'start', 'healthy', 'candidate-host', 'read:site-1', 'state', 'apply', 'verify', 'state', 'restore', 'remove', 'fail:ROUTE_SWITCH_FAILED']);
});

test('an apply error may have changed the route, so restores the prior route', async () => {
  const { calls, dependencies } = setup();
  const apply = dependencies.applyRoute;
  dependencies.applyRoute = async (...args) => { await apply(...args); throw new Error('apply failed'); };
  await assert.rejects(deployCandidate(claim, image, dependencies), /apply failed/);
  assert.deepEqual(calls, ['host:site-1', 'start', 'healthy', 'candidate-host', 'read:site-1', 'state', 'apply', 'state', 'restore', 'remove', 'fail:ROUTE_SWITCH_FAILED']);
});

test('finalize rejection restores the old route without returning ready', async () => {
  const { calls, dependencies } = setup();
  dependencies.finalizeAfterRouteVerification = async () => { calls.push('finalize'); return false; };
  await assert.rejects(deployCandidate(claim, image, dependencies), /finalize/i);
  assert.deepEqual(calls, ['host:site-1', 'start', 'healthy', 'candidate-host', 'read:site-1', 'state', 'apply', 'verify', 'finalize', 'state', 'restore', 'remove', 'fail:WORKER_INTERNAL_ERROR']);
});

test('finalize throws after commit: keeps route and never records failure', async () => {
  const { calls, dependencies, currentRoute } = setup();
  dependencies.finalizeAfterRouteVerification = async () => {
    calls.push('finalize');
    dependencies.readDeploymentState = async () => { calls.push('state'); return {
      ...pending, status: 'ready', leaseOwner: null, leaseUntil: null,
      active: { releaseId: claim.releaseId, imageDigest: image.digest, routeRevision: claim.desiredRevision },
    }; };
    throw new Error('commit acknowledgment lost');
  };
  await assert.rejects(deployCandidate(claim, image, dependencies), /coordination required/i);
  assert.equal(currentRoute(), 'candidate-2');
  assert.deepEqual(calls.slice(-2), ['finalize', 'state']);
});

test('unknown commit result keeps new route and does not write failed', async () => {
  const { calls, dependencies, currentRoute } = setup();
  dependencies.finalizeAfterRouteVerification = async () => {
    calls.push('finalize');
    dependencies.readDeploymentState = async () => { calls.push('state'); throw new Error('database unavailable'); };
    throw new Error('connection lost');
  };
  await assert.rejects(deployCandidate(claim, image, dependencies), /coordination required/i);
  assert.equal(currentRoute(), 'candidate-2');
  assert.deepEqual(calls.slice(-2), ['finalize', 'state']);
});

test('lost lease does not restore or record failure', async () => {
  const { calls, dependencies, currentRoute } = setup();
  dependencies.verifyRoute = async () => {
    calls.push('verify');
    dependencies.readDeploymentState = async () => { calls.push('state'); return { ...pending, attempts: 4 }; };
    return false;
  };
  await assert.rejects(deployCandidate(claim, image, dependencies), /coordination required/i);
  assert.equal(currentRoute(), 'candidate-2');
  assert.deepEqual(calls.slice(-2), ['verify', 'state']);
});

test('old worker cannot restore another switch at the same revision', async () => {
  const { calls, dependencies, currentRoute, switchTo } = setup();
  dependencies.verifyRoute = async () => { calls.push('verify'); switchTo('operation-2:1:other-token'); return false; };
  await assert.rejects(deployCandidate(claim, image, dependencies), /coordination required/i);
  assert.equal(currentRoute(), 'other-candidate');
  assert.deepEqual(calls.slice(-3), ['verify', 'state', 'restore']);
  assert.equal(calls.some(call => call.startsWith('fail:')), false);
});

test('restoration error is unknown and never records failure', async () => {
  const { calls, dependencies } = setup();
  const original = new Error('verification failed');
  const restoreError = new Error('restore failed');
  dependencies.verifyRoute = async () => { calls.push('verify'); throw original; };
  dependencies.restoreRoute = async () => { calls.push('restore'); throw restoreError; };
  await assert.rejects(deployCandidate(claim, image, dependencies), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /coordination required/i);
    assert.deepEqual(error.errors, [original, restoreError]);
    return true;
  });
  assert.deepEqual(calls.slice(-3), ['verify', 'state', 'restore']);
});

test('lease crossing during representative Host validation never switches the old route', async () => {
  const { calls, dependencies, currentRoute } = setup();
  const originalNow = Date.now;
  let now = claim.leaseUntil.getTime() - 10_000;
  Date.now = () => now;
  dependencies.checkRepresentativeHost = async () => { now = claim.leaseUntil.getTime() + 1; return true; };
  try {
    await assert.rejects(deployCandidate(claim, image, dependencies), /lease/i);
    assert.equal(currentRoute(), 'previous-route');
    assert.equal(calls.includes('apply'), false);
    assert.equal(calls.includes('remove'), true);
  } finally { Date.now = originalNow; }
});

test('expired attempt restores its own switch token when the database still has the old active route', async () => {
  const { calls, dependencies, currentRoute } = setup();
  const originalNow = Date.now;
  let now = claim.leaseUntil.getTime() - 10_000;
  Date.now = () => now;
  dependencies.verifyRoute = async () => { now = claim.leaseUntil.getTime() + 1; return false; };
  try {
    await assert.rejects(deployCandidate(claim, image, dependencies), /route|recorded/i);
    assert.equal(currentRoute(), 'previous-route');
    assert.equal(calls.includes('restore'), true);
    assert.equal(calls.includes('remove'), true);
  } finally { Date.now = originalNow; }
});
