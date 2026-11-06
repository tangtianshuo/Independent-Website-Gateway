import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { Pool } from 'pg';
import { authenticateSiteService, authenticateSiteServiceIdentity, serviceScopeErrorResponse } from './service-scope';

import { probeDomain, type CheckResult } from './domain-probe';

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
    const txtValue = `cms-verify=${randomBytes(32).toString('hex')}`;
    const expiresAt = Date.now() + 86400000;
    const result = await database.query('INSERT INTO "Domain" ("id", "siteId", "hostname", "verificationTokenHash", "verificationExpiresAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, now()) RETURNING "id", "siteId", "hostname", "status", "ownershipStatus", "dnsStatus", "certificateStatus", "enabled", "isPrimary"', [randomUUID(), siteId, hostname, createHash('sha256').update(txtValue).digest('hex'), new Date(expiresAt)]);
    return Response.json({ ...result.rows[0], txtName: `_cms-verify.${hostname}`, txtValue, expiresAt }, { status: 201 });
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
      deploymentHealthStatus: string | null; platformOwned: boolean; lastError: string | null;
    }>(`SELECT domain."id", domain."hostname", domain."lastError", EXISTS(SELECT 1 FROM "SourceSiteBinding" binding WHERE binding."siteId"=domain."siteId" AND binding."defaultDomainId"=domain."id") AS "platformOwned", domain."ownershipStatus", domain."dnsStatus", domain."certificateStatus",
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
      id: row.id!, hostname: row.hostname!, platformOwned: row.platformOwned === true, lastError: row.lastError || null, ownershipStatus: row.ownershipStatus || 'pending', dnsStatus: row.dnsStatus || 'pending',
      certificateStatus: row.certificateStatus || 'pending', enabled: row.enabled !== false, role: row.isPrimary ? 'primary' : 'alias',
      lastCheckedAt: row.lastCheckedAt instanceof Date ? row.lastCheckedAt.toISOString() : row.lastCheckedAt || null,
      redirectTo: row.hostname === primaryHost || !primaryHost ? null : `https://${primaryHost}`,
    }));
    const operation = (await database.query('SELECT "id","status","error","operation","domainId" FROM "DomainChange" WHERE "siteId"=$1', [siteId])).rows[0] || null;
    return json({ route, domains, operation, guidance: {entryHost:process.env.STOREFRONT_DOMAIN_ENTRY_HOST || '', entryIp:process.env.STOREFRONT_DOMAIN_ENTRY_IP || '', txtPrefix:'_cms-verify.',challengePath:'/.well-known/cms-domain-challenge'} });
  } catch {
    return json({ error: 'domain_state_unavailable' }, 503);
  }
}

interface ProbeRecord { hostname: string; platformOwned: boolean; verificationTokenHash?: string | null }
export async function checkReservedDomain(request: Request, siteId: string, domainId: string, database: Pool = pool,
  probe: (record: ProbeRecord) => Promise<CheckResult> = record => probeDomain(record, { secret: process.env.STOREFRONT_DOMAIN_SECRET || '' })): Promise<Response> {
  try { await authenticateSiteService(request, siteId, database); } catch (error) { return serviceScopeErrorResponse(error); }
  if (!uuid.test(domainId)) return json({ error: 'invalid_request' }, 400);
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT "id" FROM "Site" WHERE "id"=$1 FOR UPDATE', [siteId]);
    if ((await client.query(`SELECT 1 FROM "DomainChange" WHERE "siteId"=$1 AND "status"='pending'`, [siteId])).rowCount) return json({error:'domain_change_pending'},409);
    const row = (await client.query(`SELECT domain.*, EXISTS(SELECT 1 FROM "SourceSiteBinding" binding WHERE binding."siteId"=domain."siteId" AND binding."defaultDomainId"=domain."id") AS "platformOwned" FROM "Domain" domain WHERE domain."id"=$1 AND domain."siteId"=$2 FOR UPDATE`, [domainId, siteId])).rows[0];
    if (!row) return json({error:'domain_not_found'},404);
    if (!row.platformOwned && row.ownershipStatus !== 'verified' && (!row.verificationExpiresAt || new Date(row.verificationExpiresAt).getTime()<Date.now())) return json({error:'verification_expired'},409);
    let result: CheckResult;
    try { result = await probe(row); } catch { result = {ownership:false,dns:false,https:false,error:'Domain verification unavailable'}; }
    const ready = result.ownership && result.dns && result.https;
    await client.query(`UPDATE "Domain" SET "ownershipStatus"=$1,"dnsStatus"=$2,"certificateStatus"=$3,"status"=$4,"lastError"=$5,"lastCheckedAt"=now(),"updatedAt"=now() WHERE "id"=$6`, [result.ownership?'verified':'pending',result.dns?'ready':'pending',result.https?'ready':'pending',ready?'ready':'pending',ready?null:result.error || 'Domain verification incomplete',domainId]);
    await client.query('COMMIT');
    return json({id:domainId,ready,...result});
  } catch { return json({error:'domain_unavailable'},503); }
  finally { await client.query('ROLLBACK').catch(()=>undefined); client.release(); }
}

export async function mutateDomain(request: Request, siteId: string, domainId: string, operation: 'primary'|'state'|'remove', database: Pool = pool): Promise<Response> {
  try { await authenticateSiteService(request, siteId, database); } catch (error) { return serviceScopeErrorResponse(error); }
  if (!uuid.test(domainId)) return json({error:'invalid_request'},400);
  let enabled: boolean | null = null;
  if (operation === 'state') { try { const body = await request.json(); if (typeof body.enabled !== 'boolean') throw Error(); enabled = body.enabled; } catch { return json({error:'invalid_request'},400); } }
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT "id" FROM "Site" WHERE "id"=$1 FOR UPDATE', [siteId]);
    const row = (await client.query(`SELECT domain.*, EXISTS(SELECT 1 FROM "SourceSiteBinding" binding WHERE binding."siteId"=domain."siteId" AND binding."defaultDomainId"=domain."id") AS "platformOwned" FROM "Domain" domain WHERE domain."id"=$1 AND domain."siteId"=$2 FOR UPDATE`, [domainId,siteId])).rows[0];
    if (!row) return json({error:'domain_not_found'},404);
    if (operation === 'primary' && (!row.enabled || row.ownershipStatus !== 'verified' || row.dnsStatus !== 'ready' || row.certificateStatus !== 'ready')) return json({error:'domain_not_ready'},409);
    if ((operation==='remove' || enabled===false) && (row.isPrimary || row.platformOwned)) return json({error:'domain_protected'},409);
    const pending=(await client.query(`SELECT * FROM "DomainChange" WHERE "siteId"=$1 AND "status"='pending'`,[siteId])).rows[0];
    if (pending) return pending.domainId===domainId && pending.operation===operation && pending.enabled===enabled ? json(pending,202) : json({error:'domain_change_pending'},409);
    if ((await client.query(`SELECT 1 FROM "PublishOperation" WHERE "siteId"=$1 AND "status"='pending'`,[siteId])).rowCount) return json({error:'publish_pending'},409);
    const id=randomUUID();
    await client.query(`INSERT INTO "DomainChange" ("siteId","id","domainId","operation","enabled") VALUES ($1,$2,$3,$4,$5) ON CONFLICT ("siteId") DO UPDATE SET "id"=$2,"domainId"=$3,"operation"=$4,"enabled"=$5,"status"='pending',"error"=NULL,"retryAfter"=now(),"updatedAt"=now()`,[siteId,id,domainId,operation,enabled]);
    await client.query('COMMIT'); return json({id,status:'pending'},202);
  } catch {return json({error:'domain_unavailable'},503);}
  finally {await client.query('ROLLBACK').catch(()=>undefined);client.release();}
}
