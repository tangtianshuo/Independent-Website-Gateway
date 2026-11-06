import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { Pool } from 'pg';
import { authenticateSiteService, authenticateSiteServiceIdentity, serviceScopeErrorResponse } from './service-scope';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function normalizeHostname(hostname: string): string {
  if (!hostname || hostname !== hostname.trim() || /[\s/:*?#@\\]/u.test(hostname)) throw new Error('Invalid hostname');
  const ascii = domainToASCII(hostname.endsWith('.') ? hostname.slice(0, -1) : hostname).toLowerCase();
  const labels = ascii.split('.');
  if (!ascii || ascii.length > 253 || isIP(ascii) || labels.length < 2 ||
      labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      !/[a-z]/.test(labels[labels.length - 1])) throw new Error('Invalid hostname');
  return ascii;
}

export async function reserveDomain(request: Request, siteId: string, database: Pick<Pool, 'query'> = pool): Promise<Response> {
  try {
    authenticateSiteServiceIdentity(request);
  } catch (error) {
    return serviceScopeErrorResponse(error);
  }
  if (!uuid.test(siteId)) return Response.json({ error: 'invalid_request' }, { status: 400 });
  let hostname: string;
  try {
    const input: unknown = await request.json();
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof (input as Record<string, unknown>).hostname !== 'string') throw new Error('Invalid hostname');
    hostname = normalizeHostname((input as { hostname: string }).hostname);
  } catch {
    return Response.json({ error: 'invalid_hostname' }, { status: 400 });
  }

  let principal;
  try { principal = await authenticateSiteService(request, siteId, database); }
  catch (error) { return serviceScopeErrorResponse(error); }
  try {
    const site = await database.query('SELECT "id" FROM "Site" WHERE "id" = $1 AND "workspaceId" = $2', [siteId, principal.workspaceId]);
    if (!site.rowCount) return Response.json({ error: 'site_not_found' }, { status: 404 });
    const result = await database.query('INSERT INTO "Domain" ("id", "siteId", "hostname", "updatedAt") VALUES ($1, $2, $3, now()) RETURNING "id", "siteId", "hostname", "status", "ownershipStatus", "dnsStatus", "certificateStatus", "enabled", "isPrimary"', [randomUUID(), siteId, hostname]);
    return Response.json(result.rows[0], { status: 201 });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') return Response.json({ error: 'domain_conflict' }, { status: 409 });
    return Response.json({ error: 'domain_unavailable' }, { status: 503 });
  }
}

export async function readDomainState(request: Request, siteId: string, database: Pick<Pool, 'query'> = pool): Promise<Response> {
  let principal;
  try {
    principal = await authenticateSiteService(request, siteId, database);
  } catch (error) {
    return serviceScopeErrorResponse(error);
  }
  if (!uuid.test(siteId) || !uuid.test(principal.workspaceId)) return json({ error: 'invalid_request' }, 400);

  try {
    const result = await database.query<{
      id: string | null; hostname: string | null; ownershipStatus: string | null; dnsStatus: string | null;
      certificateStatus: string | null; enabled: boolean | null; isPrimary: boolean | null; lastCheckedAt: Date | string | null;
      publicationStatus: string | null; activeReleaseId: string | null; routeRevision: number | null; routeHost: string | null;
      deploymentHealthStatus: string | null;
    }>(`SELECT domain."id", domain."hostname", domain."ownershipStatus", domain."dnsStatus", domain."certificateStatus",
        domain."enabled", domain."isPrimary", domain."lastCheckedAt", publication."status" AS "publicationStatus",
        COALESCE(publication."activeReleaseId", active."releaseId") AS "activeReleaseId",
        COALESCE(publication."routeRevision", deployment."routeRevision", active."routeRevision") AS "routeRevision",
        deployment."host" AS "routeHost", deployment."healthStatus" AS "deploymentHealthStatus"
      FROM "Site" site
      LEFT JOIN "Domain" domain ON domain."siteId" = site."id"
      LEFT JOIN "Publication" publication ON publication."siteId" = site."id"
      LEFT JOIN "ActiveDeployment" active ON active."siteId" = site."id"
      LEFT JOIN "Deployment" deployment ON deployment."id" = active."id"
      WHERE site."id" = $1 AND site."workspaceId" = $2
      ORDER BY domain."createdAt" ASC NULLS LAST`, [siteId, principal.workspaceId]);
    if (!result.rowCount) return json({ error: 'site_not_found' }, 404);
    const first = result.rows[0];
    const routeRevision = first.routeRevision ?? 0;
    const routeStatus = first.activeReleaseId && first.routeHost ? (first.publicationStatus === 'active' ? 'active' : first.publicationStatus || 'pending') : 'unrouted';
    const route = { status: routeStatus, revision: routeRevision, releaseId: first.activeReleaseId, host: first.routeHost, health: first.deploymentHealthStatus || 'unknown' };
    const primaryHost = result.rows.find(row => row.isPrimary && row.hostname)?.hostname || first.routeHost || null;
    const domains = result.rows.filter(row => row.id && row.hostname).map(row => ({
      id: row.id!, hostname: row.hostname!, ownershipStatus: row.ownershipStatus || 'pending', dnsStatus: row.dnsStatus || 'pending',
      certificateStatus: row.certificateStatus || 'pending', enabled: row.enabled !== false, role: row.isPrimary ? 'primary' : 'alias',
      lastCheckedAt: row.lastCheckedAt instanceof Date ? row.lastCheckedAt.toISOString() : row.lastCheckedAt || null,
      redirectTo: row.hostname === primaryHost || !primaryHost ? null : `https://${primaryHost}`,
    }));
    return json({ route, domains });
  } catch {
    return json({ error: 'domain_state_unavailable' }, 503);
  }
}
