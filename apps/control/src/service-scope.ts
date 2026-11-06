import type { Pool } from 'pg';
import { authenticateCmsService, authenticateService } from './auth';

export interface CmsSourceIdentity {
  instanceId: string;
  cmsWorkspaceId: string;
  cmsSiteId: string;
}

export class ServiceScopeError extends Error {
  constructor(public readonly status: 400 | 401 | 404, message: string) { super(message); }
}

// Reject coalesced duplicate headers as well as empty, padded or control values.
export function validSourceIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !/[,\s\u0000-\u001f\u007f]/u.test(value);
}

export function serviceScopeErrorResponse(error: unknown): Response {
  if (error instanceof ServiceScopeError) return Response.json({ error: error.message }, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
  if (error instanceof Error && error.message === 'Unauthorized') return Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  return Response.json({ error: 'service_scope_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
}

export function authenticateSiteServiceIdentity(request: Request): CmsSourceIdentity | { workspaceId: string } {
  const authorization = request.headers.get('authorization') ?? undefined;
  const hasWorkspace = request.headers.has('X-CMS-Workspace');
  const hasSite = request.headers.has('X-CMS-Site');
  if (hasWorkspace || hasSite) {
    const { instanceId } = authenticateCmsService(authorization);
    const cmsWorkspaceId = request.headers.get('X-CMS-Workspace');
    const cmsSiteId = request.headers.get('X-CMS-Site');
    if (!hasWorkspace || !hasSite || !validSourceIdentifier(cmsWorkspaceId) || !validSourceIdentifier(cmsSiteId)) throw new ServiceScopeError(404, 'site_not_found');
    return { instanceId, cmsWorkspaceId, cmsSiteId };
  }
  return authenticateService(authorization, { secret: process.env.CMS_SERVICE_SECRET ?? '', workspaceId: process.env.CMS_WORKSPACE_ID ?? '' });
}

export async function authenticateSiteService(request: Request, siteId: string, pool: Pick<Pool, 'query'>): Promise<{ workspaceId: string }> {
  const identity = authenticateSiteServiceIdentity(request);
  if (!validSiteId(siteId)) throw new ServiceScopeError(400, 'invalid_request');
  let workspaceId: string;
  if ('instanceId' in identity) {
    const { instanceId, cmsWorkspaceId, cmsSiteId } = identity;
    const result = await pool.query<{ workspaceId: string }>(`SELECT site."workspaceId"
      FROM "SourceSiteBinding" binding
      JOIN "SourceWorkspaceBinding" source ON source."instanceId" = binding."instanceId" AND source."cmsWorkspaceId" = binding."cmsWorkspaceId" AND source."workspaceId" = binding."workspaceId"
      JOIN "Site" site ON site."id" = binding."siteId" AND site."workspaceId" = source."workspaceId"
      WHERE binding."instanceId" = $1 AND binding."cmsWorkspaceId" = $2 AND binding."cmsSiteId" = $3 AND binding."siteId" = $4`, [instanceId, cmsWorkspaceId, cmsSiteId, siteId]);
    if (!result.rowCount) throw new ServiceScopeError(404, 'site_not_found');
    workspaceId = result.rows[0].workspaceId;
  } else {
    workspaceId = identity.workspaceId;
    if (!validSiteId(workspaceId)) throw new ServiceScopeError(400, 'invalid_request');
    const site = await pool.query('SELECT "id" FROM "Site" WHERE "id" = $1 AND "workspaceId" = $2', [siteId, workspaceId]);
    if (!site.rowCount) throw new ServiceScopeError(404, 'site_not_found');
  }
  return { workspaceId };
}

function validSiteId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
