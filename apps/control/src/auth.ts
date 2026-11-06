import { createHash, timingSafeEqual } from 'node:crypto';

export interface ServicePrincipal {
  workspaceId: string;
}

export interface ServiceIdentityConfig {
  secret: string;
  workspaceId: string;
}

export function authenticateService(authorization: string | undefined, identity: ServiceIdentityConfig): ServicePrincipal {
  if (!identity.workspaceId) throw new Error('Unauthorized');
  authenticateBearer(authorization, identity.secret);
  return { workspaceId: identity.workspaceId };
}

function authenticateBearer(authorization: string | undefined, secret: string): void {
  if (!secret) throw new Error('Unauthorized');
  const match = /^Bearer (.+)$/.exec(authorization ?? '');
  const supplied = match?.[1] ?? '';
  const expectedDigest = createHash('sha256').update(secret).digest();
  const suppliedDigest = createHash('sha256').update(supplied).digest();
  if (!match || !timingSafeEqual(suppliedDigest, expectedDigest)) throw new Error('Unauthorized');
}

export function authenticateCmsService(authorization: string | undefined): { instanceId: string } {
  authenticateBearer(authorization, process.env.CMS_SERVICE_SECRET ?? '');
  const instanceId = process.env.CMS_INSTANCE_ID ?? '';
  if (!instanceId || instanceId.length > 256 || instanceId.trim() !== instanceId || /[,\s\u0000-\u001f\u007f]/u.test(instanceId)) throw new Error('Unauthorized');
  return { instanceId };
}

export function authorizeWorkspace(principal: ServicePrincipal, requestedWorkspaceId: string): void {
  if (principal.workspaceId !== requestedWorkspaceId) throw new Error('Forbidden');
}
