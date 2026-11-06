import type { Pool } from 'pg';
import { writeDomainState } from '../../traffic/dist/state.js';
import { readDomainRoute } from './domain-routing.js';
import { checkCandidate, type Route } from './runtime.js';

export async function projectReservedDomains(pool: Pick<Pool, 'query'>, path: string): Promise<void> {
  const result = await pool.query<{hostname:string}>('SELECT "hostname" FROM "Domain" WHERE "enabled"=true ORDER BY "hostname"');
  await writeDomainState(path,result.rows.map(row=>row.hostname));
}
interface DomainRouter {
  readRoute(siteId: string): Promise<Route | undefined>;
  applyRoute(siteId:string,revision:number,port:number,host:string,token:string,containerId?:string,releaseId?:string,redirectHosts?:string[]): Promise<void>;
}
/** The same Site row serializes publish creation/claims and domain changes.
 * A pending intent survives a crash after the durable route write. Replaying it
 * derives rollback from committed Domain rows, not the uncommitted route file.
 */
export async function processDomainChange(pool: Pool, router: DomainRouter, verify: (route: Route) => Promise<boolean> = route => checkCandidate(route.port,route.host,'/')): Promise<boolean> {
  const client=await pool.connect();
  let old: Route | undefined;
  let committing=false;
  let recoveryRequired=false;
  let intent: {siteId:string;id:string;domainId:string;operation:string;enabled:boolean|null} | undefined;
  try {
    await client.query('BEGIN');
    intent=(await client.query(`SELECT change.* FROM "DomainChange" change JOIN "Site" site ON site."id"=change."siteId" WHERE change."status"='pending' AND NOT EXISTS(SELECT 1 FROM "PublishOperation" operation WHERE operation."siteId"=site."id" AND operation."status"='pending') ORDER BY change."updatedAt" FOR UPDATE OF site,change SKIP LOCKED LIMIT 1`)).rows[0];
    if (!intent) {await client.query('ROLLBACK');return false;}
    recoveryRequired=true;
    const committed=await readDomainRoute(client as unknown as Pick<Pool,'query'>,intent.siteId);
    const route=await router.readRoute(intent.siteId);
    const active=(await client.query('SELECT active."releaseId",active."routeRevision",deployment."host" FROM "ActiveDeployment" active LEFT JOIN "Deployment" deployment ON deployment."id"=active."id" WHERE active."siteId"=$1',[intent.siteId])).rows[0];
    if (active && (!route || route.releaseId!==active.releaseId || route.revision!==active.routeRevision)) {
      throw Error('Active route unavailable on this worker; recovery required');
    }
    if (route) {
      const primary=(await client.query('SELECT "hostname" FROM "Domain" WHERE "siteId"=$1 AND "isPrimary"=true',[intent.siteId])).rows[0];
      // Rollback is the committed serving identity, regardless of a later failed
      // readiness recheck. A ready-host fallback is only a new-route selection.
      const host=active?.host || primary?.hostname || route.host;
      old={...route,host,redirectHosts:[committed.host,...committed.redirectHosts].filter(value=>value && value!==host)};
    }
    recoveryRequired=false;
    const domain=(await client.query('SELECT * FROM "Domain" WHERE "id"=$1 AND "siteId"=$2 FOR UPDATE',[intent.domainId,intent.siteId])).rows[0];
    if (!domain) throw Error('Domain not found');
    if (intent.operation==='primary') {
      if (!domain.enabled || domain.ownershipStatus!=='verified' || domain.dnsStatus!=='ready' || domain.certificateStatus!=='ready') throw Error('Domain not ready');
      await client.query('UPDATE "Domain" SET "isPrimary"=false,"updatedAt"=now() WHERE "siteId"=$1',[intent.siteId]);
      await client.query('UPDATE "Domain" SET "isPrimary"=true,"updatedAt"=now() WHERE "id"=$1',[intent.domainId]);
    } else if (intent.operation==='state') await client.query('UPDATE "Domain" SET "enabled"=$1,"updatedAt"=now() WHERE "id"=$2',[intent.enabled,intent.domainId]);
    else await client.query('DELETE FROM "Domain" WHERE "id"=$1',[intent.domainId]);
    const desired=await readDomainRoute(client as unknown as Pick<Pool,'query'>,intent.siteId);
    if (route && old && intent.operation!=='primary') {
      // Readiness changes never authorize a primary switch. Alias operations
      // keep the committed serving host and change only the requested alias.
      desired.host=old.host;
      desired.redirectHosts=(route.redirectHosts ?? []).filter(host=>host!==domain.hostname && host!==desired.host);
      if (intent.operation==='state' && intent.enabled && domain.hostname!==old.host &&
          domain.ownershipStatus==='verified' && domain.dnsStatus==='ready' && domain.certificateStatus==='ready') {
        desired.redirectHosts.push(domain.hostname);
      }
    }
    if (route) {
      const next={...route,host:desired.host,redirectHosts:desired.redirectHosts,token:intent.id};
      if (!desired.host || !await verify(next)) throw Error('Domain route verification failed');
      await router.applyRoute(next.siteId,next.revision,next.port,next.host,next.token,next.containerId,next.releaseId,next.redirectHosts);
      if (!await verify(next)) throw Error('Domain route verification failed');
      await client.query('UPDATE "Deployment" SET "host"=$1 WHERE "id"=(SELECT "id" FROM "ActiveDeployment" WHERE "siteId"=$2)',[desired.host,intent.siteId]);
    }
    await client.query(`UPDATE "DomainChange" SET "status"='succeeded',"error"=NULL,"updatedAt"=now() WHERE "siteId"=$1 AND "id"=$2`,[intent.siteId,intent.id]);
    committing=true;
    await client.query('COMMIT');return true;
  } catch (error) {
    // An ambiguous COMMIT must not undo a possibly committed route. The durable
    // intent is either succeeded or still pending and will converge on retry.
    if (committing || recoveryRequired) throw error;
    // Restore before releasing the Site lock. If restoration fails leave the
    // intent pending; next tick/restart retries it instead of reporting success.
    if (old) {
      // Never report a terminal failure while an uncommitted public route is
      // left behind. An unavailable committed target leaves the intent pending.
      if (!await verify(old)) throw Error('Committed route unavailable; recovery required');
      await router.applyRoute(old.siteId,old.revision,old.port,old.host,old.token,old.containerId,old.releaseId,old.redirectHosts);
    }
    await client.query('ROLLBACK');
    if (intent) await client.query(`UPDATE "DomainChange" SET "status"='failed',"error"=$1,"updatedAt"=now() WHERE "siteId"=$2 AND "id"=$3 AND "status"='pending'`,[(error as Error).message.slice(0,300),intent.siteId,intent.id]);
    else throw error;
    return true;
  } finally {await client.query('ROLLBACK').catch(()=>undefined);client.release();}
}
