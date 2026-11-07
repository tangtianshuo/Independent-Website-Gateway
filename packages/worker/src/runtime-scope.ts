import type { Pool } from 'pg';

const scopePattern = /^restore-[a-f0-9]{24}$/;
export function runtimeOwnership(runtimeScope?: string) {
  if (runtimeScope !== undefined && !scopePattern.test(runtimeScope)) throw new Error('Invalid runtime scope');
  const siteKey = runtimeScope ? 'gateway.restore.site-id' : 'gateway.site-id';
  const releaseKey = runtimeScope ? 'gateway.restore.release-id' : 'gateway.release-id';
  const keys = runtimeScope ? [siteKey, releaseKey, 'gateway.runtime-scope'] : [siteKey, releaseKey];
  return {
    siteKey, releaseKey, keys,
    filters: runtimeScope ? [siteKey, releaseKey, `gateway.runtime-scope=${runtimeScope}`] : [siteKey, releaseKey],
    labels: (siteId: string, releaseId: string): Record<string, string> => ({ [siteKey]: siteId, [releaseKey]: releaseId, ...(runtimeScope ? { 'gateway.runtime-scope': runtimeScope } : {}) }),
    matches(labels: Record<string, unknown> | undefined): boolean {
      if (!labels || typeof labels[siteKey] !== 'string' || typeof labels[releaseKey] !== 'string') return false;
      return runtimeScope
        ? labels['gateway.runtime-scope'] === runtimeScope && !Object.hasOwn(labels, 'gateway.site-id') && !Object.hasOwn(labels, 'gateway.release-id')
        : !Object.hasOwn(labels, 'gateway.runtime-scope') && !Object.hasOwn(labels, 'gateway.restore.site-id') && !Object.hasOwn(labels, 'gateway.restore.release-id');
    },
  };
}

// The marker survives database renames/copies. Restores replace it with a fresh
// destination identity before any reconstructed worker is allowed to run.
export async function requireDatabaseRuntimeScope(pool: Pick<Pool, 'query'>, configured?: string): Promise<string | undefined> {
  if (configured !== undefined) runtimeOwnership(configured);
  const result = await pool.query(`SELECT current_database() AS database, to_regclass('public."GatewayRuntimeScope"') AS marker`);
  const { database, marker } = result.rows[0];
  if (!marker) {
    if (configured !== undefined || /^platform_restore_/.test(database)) throw new Error('restored_database_scope_required');
    return undefined;
  }
  const scopes = await pool.query('SELECT scope FROM public."GatewayRuntimeScope"');
  if (scopes.rows.length !== 1 || typeof scopes.rows[0].scope !== 'string' || !scopePattern.test(scopes.rows[0].scope) || scopes.rows[0].scope !== configured) throw new Error('restored_database_scope_mismatch');
  return scopes.rows[0].scope;
}
