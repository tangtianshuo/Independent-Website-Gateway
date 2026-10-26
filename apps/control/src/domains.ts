import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { Pool } from 'pg';
import { authenticateService } from './auth';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeHostname(hostname: string): string {
  if (!hostname || hostname !== hostname.trim() || /[\s/:*?#@\\]/u.test(hostname)) throw new Error('Invalid hostname');
  const ascii = domainToASCII(hostname.endsWith('.') ? hostname.slice(0, -1) : hostname).toLowerCase();
  const labels = ascii.split('.');
  if (!ascii || ascii.length > 253 || isIP(ascii) || labels.length < 2 ||
      labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      !/[a-z]/.test(labels[labels.length - 1])) throw new Error('Invalid hostname');
  return ascii;
}

export async function reserveDomain(request: Request, siteId: string): Promise<Response> {
  let principal;
  try {
    principal = authenticateService(request.headers.get('authorization') ?? undefined, {
      secret: process.env.CMS_SERVICE_SECRET ?? '',
      workspaceId: process.env.CMS_WORKSPACE_ID ?? '',
    });
  } catch {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!uuid.test(siteId) || !uuid.test(principal.workspaceId)) return Response.json({ error: 'invalid_request' }, { status: 400 });
  let hostname: string;
  try {
    const input: unknown = await request.json();
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof (input as Record<string, unknown>).hostname !== 'string') throw new Error('Invalid hostname');
    hostname = normalizeHostname((input as { hostname: string }).hostname);
  } catch {
    return Response.json({ error: 'invalid_hostname' }, { status: 400 });
  }

  try {
    const site = await pool.query('SELECT "id" FROM "Site" WHERE "id" = $1 AND "workspaceId" = $2', [siteId, principal.workspaceId]);
    if (!site.rowCount) return Response.json({ error: 'site_not_found' }, { status: 404 });
    const result = await pool.query('INSERT INTO "Domain" ("id", "siteId", "hostname", "updatedAt") VALUES ($1, $2, $3, now()) RETURNING "id", "siteId", "hostname", "status", "certificateStatus"', [randomUUID(), siteId, hostname]);
    return Response.json(result.rows[0], { status: 201 });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') return Response.json({ error: 'domain_conflict' }, { status: 409 });
    return Response.json({ error: 'domain_unavailable' }, { status: 503 });
  }
}
