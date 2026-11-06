import type { Pool } from 'pg';

export async function readDomainRoute(pool: Pick<Pool, 'query'>, siteId: string): Promise<{ host: string; redirectHosts: string[] }> {
  const result = await pool.query<{ hostname: string; isPrimary: boolean }>(`SELECT "hostname", "isPrimary" FROM "Domain"
    WHERE "siteId"=$1 AND "enabled"=true AND "ownershipStatus"='verified' AND "dnsStatus"='ready' AND "certificateStatus"='ready'
    ORDER BY "isPrimary" DESC, "hostname"`, [siteId]);
  const host = result.rows[0]?.hostname ?? '';
  return { host, redirectHosts: result.rows.filter(row => row.hostname !== host).map(row => row.hostname) };
}
