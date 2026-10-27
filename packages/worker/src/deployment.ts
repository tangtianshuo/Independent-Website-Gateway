import { randomUUID } from 'node:crypto';
import type { ClaimedOperation } from './claim.js';
import type { FailureInput, FinalizeInput } from './operations.js';

interface ImageIdentity {
  repository: string;
  digest: string;
  sourceCommit?: string;
  manifestChecksum?: string;
}

export interface DeploymentState {
  status: string;
  desiredRevision: number;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  attempts: number;
  active: { releaseId: string; imageDigest: string; routeRevision: number } | null;
}

// The Host and route snapshot must come from trusted worker-side domain/route state, never request input.
export interface DeploymentDependencies<Route> {
  getRepresentativeHost(siteId: string): Promise<string>;
  readRoute(siteId: string): Promise<Route>;
  readDeploymentState(operationId: string): Promise<DeploymentState | null>;
  startCandidate(candidate: { siteId: string; releaseId: string; image: ImageIdentity }): Promise<string>;
  removeCandidate(containerId: string): Promise<void>;
  waitHealthy(containerId: string): Promise<boolean>;
  checkRepresentativeHost(containerId: string, host: string): Promise<boolean>;
  applyRoute(siteId: string, revision: number, containerId: string, host: string, switchToken: string): Promise<void>;
  verifyRoute(siteId: string, revision: number, host: string): Promise<boolean>;
  // Adapter must atomically compare the current route's switch token and restore only on equality.
  restoreRoute(siteId: string, expectedSwitchToken: string, previous: Route): Promise<boolean>;
  finalizeAfterRouteVerification(input: FinalizeInput): Promise<boolean>;
  failPublishOperation(input: FailureInput): Promise<boolean>;
}

export async function deployCandidate<Route>(
  claim: ClaimedOperation, image: ImageIdentity, dependencies: DeploymentDependencies<Route>,
): Promise<boolean> {
  let previous: Route | undefined;
  let containerId: string | undefined;
  let routeAttempted = false;
  const switchToken = `${claim.id}:${claim.attempts}:${randomUUID()}`;
  let failureCode = 'WORKER_INTERNAL_ERROR';
  const ownsAttempt = (state: DeploymentState | null): state is DeploymentState => !!state &&
    state.status === 'pending' && state.desiredRevision === claim.desiredRevision &&
    state.leaseOwner === claim.leaseOwner && state.attempts === claim.attempts &&
    state.leaseUntil?.getTime() === claim.leaseUntil.getTime() &&
    state.active?.routeRevision !== claim.desiredRevision;
  const requireLeaseBudget = () => {
    if (Date.now() >= claim.leaseUntil.getTime() - 5000) throw new Error('Deployment lease has insufficient activation time');
  };
  try {
    requireLeaseBudget();
    const host = await dependencies.getRepresentativeHost(claim.siteId);
    if (!host) throw new Error('Representative Host unavailable');
    requireLeaseBudget();
    failureCode = 'CANDIDATE_START_FAILED';
    containerId = await dependencies.startCandidate({ siteId: claim.siteId, releaseId: claim.releaseId, image });
    failureCode = 'CANDIDATE_UNHEALTHY';
    if (!await dependencies.waitHealthy(containerId)) throw new Error('Candidate is not healthy');
    if (!await dependencies.checkRepresentativeHost(containerId, host)) throw new Error('Representative Host check failed');
    previous = await dependencies.readRoute(claim.siteId);
    requireLeaseBudget();
    if (!ownsAttempt(await dependencies.readDeploymentState(claim.id))) throw new Error('Deployment lease was superseded');
    requireLeaseBudget();
    failureCode = 'ROUTE_SWITCH_FAILED';
    routeAttempted = true;
    await dependencies.applyRoute(claim.siteId, claim.desiredRevision, containerId, host, switchToken);
    if (!await dependencies.verifyRoute(claim.siteId, claim.desiredRevision, host)) throw new Error('Route verification failed');
    failureCode = 'WORKER_INTERNAL_ERROR';
    const pinIdentity = image.repository === 'local' ? {} : {
      imageRepository: image.repository,
      ...(image.sourceCommit ? { sourceCommit: image.sourceCommit } : {}),
      ...(image.manifestChecksum ? { manifestChecksum: image.manifestChecksum } : {}),
    };
    const finalized = await dependencies.finalizeAfterRouteVerification({
      operationId: claim.id, workerId: claim.leaseOwner, attempts: claim.attempts,
      leaseUntil: claim.leaseUntil, imageDigest: image.digest,
      ...pinIdentity,
    });
    if (!finalized) throw new Error('Deployment finalize rejected');
    return true;
  } catch (error) {
    if (routeAttempted) {
      let state: DeploymentState | null;
      try {
        state = await dependencies.readDeploymentState(claim.id);
      } catch (stateError) {
        throw new AggregateError([error, stateError], 'Deployment outcome unknown; coordination required');
      }
      // Expiry alone does not transfer ownership. The switch token still fences
      // restoration; never restore over a committed or reclaimed attempt.
      if (!ownsAttempt(state)) {
        throw new Error('Deployment outcome unknown; coordination required', { cause: error });
      }
      let restored: boolean;
      try {
        restored = await dependencies.restoreRoute(claim.siteId, switchToken, previous as Route);
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], 'Route restoration outcome unknown; coordination required');
      }
      if (!restored) throw new Error('Route switch token mismatch; coordination required', { cause: error });
    }
    const errors: unknown[] = [error];
    if (containerId) {
      try { await dependencies.removeCandidate(containerId); }
      catch (cleanupError) { errors.push(cleanupError); }
    }
    try {
      const recorded = await dependencies.failPublishOperation({
        operationId: claim.id, workerId: claim.leaseOwner, attempts: claim.attempts,
        leaseUntil: claim.leaseUntil, failureCode,
      });
      if (!recorded) errors.push(new Error('Deployment failure could not be recorded under the current lease'));
    } catch (recordError) {
      errors.push(recordError);
    }
    if (errors.length > 1) throw new AggregateError(errors, 'Candidate deployment failed; cleanup incomplete');
    throw error;
  }
}
