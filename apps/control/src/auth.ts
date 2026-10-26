import { createHash, timingSafeEqual } from 'node:crypto';

export interface ServicePrincipal {
  workspaceId: string;
}

export interface ServiceIdentityConfig {
  secret: string;
  workspaceId: string;
}

export function authenticateService(authorization: string | undefined, identity: ServiceIdentityConfig): ServicePrincipal {
  if (!identity.secret || !identity.workspaceId) throw new Error('Unauthorized');
  const match = /^Bearer (.+)$/.exec(authorization ?? '');
  const supplied = match?.[1] ?? '';
  const expectedDigest = createHash('sha256').update(identity.secret).digest();
  const suppliedDigest = createHash('sha256').update(supplied).digest();
  if (!match || !timingSafeEqual(suppliedDigest, expectedDigest)) throw new Error('Unauthorized');
  return { workspaceId: identity.workspaceId };
}

export function authorizeWorkspace(principal: ServicePrincipal, requestedWorkspaceId: string): void {
  if (principal.workspaceId !== requestedWorkspaceId) throw new Error('Forbidden');
}
