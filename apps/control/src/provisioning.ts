import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { normalizeHostname } from './domains';
import { validSourceIdentifier } from './service-scope';

export interface ProvisionInput { cmsWorkspaceId: string; cmsSiteId: string; name: string; requestKey: string }
export interface ProvisionResult {
  cmsWorkspaceId: string; cmsSiteId: string; workspaceId: string; siteId: string; siteUrl: string; status: 'provisioned';
}
export class ProvisionError extends Error {
  constructor(public readonly status: 400 | 409, message: string) { super(message); }
}
interface Binding { requestKey: string; cmsWorkspaceId: string; cmsSiteId: string; workspaceId: string; siteId: string; hostname: string }
const bindingQuery = `SELECT binding."requestKey", binding."cmsWorkspaceId", binding."cmsSiteId", binding."workspaceId", binding."siteId", domain."hostname"
  FROM "SourceSiteBinding" binding
  JOIN "SourceWorkspaceBinding" source ON source."instanceId" = binding."instanceId" AND source."cmsWorkspaceId" = binding."cmsWorkspaceId" AND source."workspaceId" = binding."workspaceId"
  JOIN "Site" site ON site."id" = binding."siteId" AND site."workspaceId" = source."workspaceId"
  JOIN "Domain" domain ON domain."siteId" = site."id" AND domain."id" = binding."defaultDomainId"`;

async function existing(database: Pick<PoolClient, 'query'>, instanceId: string, input: ProvisionInput): Promise<ProvisionResult | undefined> {
  const key = await database.query<{ cmsWorkspaceId: string; cmsSiteId: string }>('SELECT "cmsWorkspaceId", "cmsSiteId" FROM "SourceSiteBinding" WHERE "instanceId"=$1 AND "requestKey"=$2', [instanceId, input.requestKey]);
  if (key.rowCount && (key.rows[0].cmsWorkspaceId !== input.cmsWorkspaceId || key.rows[0].cmsSiteId !== input.cmsSiteId)) throw new ProvisionError(409, 'binding_conflict');
  const result = await database.query<Binding>(`${bindingQuery} WHERE binding."instanceId"=$1 AND binding."cmsWorkspaceId"=$2 AND binding."cmsSiteId"=$3`, [instanceId, input.cmsWorkspaceId, input.cmsSiteId]);
  if (!result.rowCount) return undefined;
  const row = result.rows[0];
  if (row.requestKey !== input.requestKey) throw new ProvisionError(409, 'binding_conflict');
  return { cmsWorkspaceId: row.cmsWorkspaceId, cmsSiteId: row.cmsSiteId, workspaceId: row.workspaceId, siteId: row.siteId, siteUrl: `https://${row.hostname}`, status: 'provisioned' };
}

export async function provisionSite(pool: Pool, instanceId: string, input: ProvisionInput, platformDomain: string): Promise<ProvisionResult> {
  if (!validSourceIdentifier(instanceId) || !input || !validSourceIdentifier(input.cmsWorkspaceId) || !validSourceIdentifier(input.cmsSiteId) || !validSourceIdentifier(input.requestKey) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 256) throw new ProvisionError(400, 'invalid_request');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([instanceId, input.cmsWorkspaceId])]);
    const replay = await existing(client, instanceId, input);
    if (replay) { await client.query('COMMIT'); return replay; }
    let hostnameSuffix: string;
    try { hostnameSuffix = normalizeHostname(platformDomain); normalizeHostname(`s-${'a'.repeat(32)}.${hostnameSuffix}`); }
    catch { throw new Error('Invalid platform domain configuration'); }
    let workspaceId: string;
    const workspace = await client.query<{ workspaceId: string }>('SELECT "workspaceId" FROM "SourceWorkspaceBinding" WHERE "instanceId"=$1 AND "cmsWorkspaceId"=$2', [instanceId, input.cmsWorkspaceId]);
    if (workspace.rowCount) workspaceId = workspace.rows[0].workspaceId;
    else {
      workspaceId = randomUUID();
      await client.query('INSERT INTO "Workspace" ("id","name","updatedAt") VALUES ($1,$2,now())', [workspaceId, input.name]);
      await client.query('INSERT INTO "SourceWorkspaceBinding" ("instanceId","cmsWorkspaceId","workspaceId") VALUES ($1,$2,$3)', [instanceId, input.cmsWorkspaceId, workspaceId]);
    }
    const siteId = randomUUID();
    const defaultDomainId = randomUUID();
    const hostname = `s-${siteId.replaceAll('-', '')}.${hostnameSuffix}`;
    await client.query('INSERT INTO "Site" ("id","workspaceId","updatedAt") VALUES ($1,$2,now())', [siteId, workspaceId]);
    await client.query(`INSERT INTO "Domain" ("id","siteId","hostname","status","ownershipStatus","dnsStatus","certificateStatus","isPrimary","updatedAt") VALUES ($1,$2,$3,'pending','pending','pending','pending',true,now())`, [defaultDomainId, siteId, hostname]);
    await client.query('INSERT INTO "SourceSiteBinding" ("instanceId","cmsWorkspaceId","cmsSiteId","workspaceId","siteId","requestKey","defaultDomainId") VALUES ($1,$2,$3,$4,$5,$6,$7)', [instanceId, input.cmsWorkspaceId, input.cmsSiteId, workspaceId, siteId, input.requestKey, defaultDomainId]);
    await client.query('COMMIT');
    return { cmsWorkspaceId: input.cmsWorkspaceId, cmsSiteId: input.cmsSiteId, workspaceId, siteId, siteUrl: `https://${hostname}`, status: 'provisioned' };
  } catch (error) {
    await client.query('ROLLBACK');
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      // A different workspace may have won the instance-wide request-key race.
      // Read only after rollback, never commit the losing workspace/site/domain.
      const replay = await existing(client, instanceId, input);
      if (replay) return replay;
      throw new ProvisionError(409, 'provisioning_conflict');
    }
    throw error;
  } finally { client.release(); }
}
