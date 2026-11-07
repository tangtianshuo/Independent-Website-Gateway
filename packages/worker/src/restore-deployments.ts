/** Offline isolated reconstruction. Run only before starting restored writers. */
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { readFile, writeFile, rename, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import type { RouteStateEntry, RouteStateSnapshot } from '../../traffic/dist/state.js';
import { createDockerEngineClient } from './docker-client.js';
import { createDockerCandidateAdapter } from './docker.js';
import { artifactSnapshotPath, ensureArtifactReadable } from './artifacts.js';
import { checkCandidate } from './runtime.js';

type Active = { siteId: string; releaseId: string; routeRevision: number; host: string };
export async function rebuildRoutes(saved: RouteStateSnapshot, active: Active[], rebuild: (deployment: Active, prior: RouteStateEntry) => Promise<RouteStateEntry>): Promise<RouteStateSnapshot> {
  const routes = new Map<string, RouteStateEntry>();
  for (const item of active) {
    const prior = [...saved.routes,...saved.previous].find(route => route.siteId===item.siteId && route.releaseId===item.releaseId && route.revision===item.routeRevision && route.host===item.host);
    if (!prior) throw new Error('committed_route_missing');
    const route = await rebuild(item, prior);
    if (route.siteId!==item.siteId || route.releaseId!==item.releaseId || route.revision!==item.routeRevision || route.host!==item.host || route.containerId===prior.containerId || route.port===prior.port || route.token===prior.token) throw new Error('invalid_rebuilt_route');
    routes.set(item.siteId,route);
  }
  // Full original state remains in saved-routes.json; never expose source physical targets.
  return {routes:[...routes.values()],previous:[]};
}

async function freePort(excluded: Set<number>): Promise<number> {
  for (;;) {
    const server=createServer(); await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
    const address=server.address(); const port=typeof address==='object'&&address?address.port:0;
    await new Promise<void>(r=>server.close(()=>r()));
    if (port && !excluded.has(port)) { excluded.add(port); return port; }
  }
}

export async function restoreDeployments(root: string): Promise<{count:number}> {
  root=resolve(root);
  const receipt=JSON.parse(await readFile(join(root,'restore-private.json'),'utf8'));
  const url=new URL(process.env.DATABASE_URL || '');
  if (url.pathname.slice(1)!==receipt.postgresDatabase || !/^platform_restore_[a-f0-9]{24}$/.test(receipt.postgresDatabase) || receipt.status!=='databases-restored') throw new Error('isolated_restore_receipt_required');
  const lockBytes=await readFile(join(root,'platform-lock.json'));
  if ('sha256:'+createHash('sha256').update(lockBytes).digest('hex')!==receipt.lockChecksum) throw new Error('restore_lock_checksum_mismatch');
  const platformLock=JSON.parse(lockBytes.toString());
  const saved:RouteStateSnapshot=JSON.parse(await readFile(join(root,'saved-routes.json'),'utf8'));
  const lock=await open(join(root,'.reconstruction-owner'),'wx',0o600);
  const pool=new Pool({connectionString:url.href});
  let client: PoolClient | undefined;
  const created:string[]=[];
  const docker=createDockerEngineClient({socketPath:process.env.DOCKER_SOCKET_PATH,approvedImages:[]});
  let committed=false, commitAttempted=false;
  try {
    client=await pool.connect();
    const connection=client;
    await connection.query('BEGIN');
    if ((await connection.query('SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()')).rowCount) throw new Error('restore_writers_running');
    await connection.query('UPDATE "PublishOperation" SET "leaseOwner"=NULL,"leaseUntil"=NULL,"candidateCredentialHash"=NULL,"attempts"="attempts"+1 WHERE "leaseOwner" IS NOT NULL OR "candidateCredentialHash" IS NOT NULL');
    for (const table of ['Release','ReleaseArtifact']) {
      const rows=await connection.query(`SELECT "id","siteId","releaseId","checksum" FROM "${table}" WHERE "snapshotRef" IS NOT NULL`);
      for (const row of rows.rows) {
        const file=await ensureArtifactReadable(join(root,'artifacts'),row.siteId,row.releaseId,row.checksum);
        await connection.query(`UPDATE "${table}" SET "snapshotRef"=$1 WHERE id=$2`,[file,row.id]);
      }
    }
    const active=await connection.query(`SELECT a.*,s."workspaceId",d.host,d."artifactId",r.metadata,artifact.checksum,artifact."rendererDigest"
      FROM "ActiveDeployment" a JOIN "Site" s ON s.id=a."siteId" JOIN "Deployment" d ON d.id=a.id
      JOIN "Release" r ON r."siteId"=a."siteId" AND r."releaseId"=a."releaseId"
      JOIN "ReleaseArtifact" artifact ON artifact.id=d."artifactId"
`);
    const count=Number((await connection.query('SELECT count(*) FROM "ActiveDeployment"')).rows[0].count);
    if (active.rows.length!==count) throw new Error('active_release_identity_missing');
    const excluded=new Set([...saved.routes,...saved.previous].map(r=>r.port));
    const rebuilt=await rebuildRoutes(saved,active.rows,async item=>{
      const row=active.rows.find(row=>row.siteId===item.siteId)!;
      if (row.rendererDigest!==row.imageDigest || row.metadata.imageDigest!==row.imageDigest) throw new Error('renderer_identity_mismatch');
      const local=receipt.evidenceType==='source-only-local' && process.env.PLATFORM_RESTORE_LOCAL_IMAGE===row.imageDigest;
      const locked=platformLock.templates?.find((entry: {id:string;version:string;imageDigest:string;manifestChecksum:string})=>entry.id===row.metadata.templateId && entry.version===row.metadata.templateVersion && entry.imageDigest===row.imageDigest && entry.manifestChecksum===row.metadata.manifestChecksum);
      if (!local && (receipt.evidenceType!=='platform-lock-bound' || !locked || !/^[a-z][a-z0-9-]*$/.test(row.metadata.templateId))) throw new Error('formal_renderer_identity_required');
      const image={repository:local?'local':`ghcr.io/tangtianshuo/independent-website-templates/${row.metadata.templateId}`,digest:row.imageDigest};
      const imageRef=local?image.digest:`${image.repository}@${image.digest}`;
      const engine=createDockerEngineClient({socketPath:process.env.DOCKER_SOCKET_PATH,approvedImages:[imageRef]});
      if (!local) await engine.pull(imageRef);
      const adapter=createDockerCandidateAdapter(engine,{network:process.env.GATEWAY_RESTORE_NETWORK || 'gateway-sites',images:[image]});
      const port=await freePort(excluded),credential=randomBytes(32).toString('hex');
      const id=await adapter.startCandidate({siteId:item.siteId,releaseId:item.releaseId,image,workspaceId:row.workspaceId,credential,gatewayUrl:process.env.GATEWAY_CONTROL_URL!,hostPort:port,snapshotRef:artifactSnapshotPath(join(root,'artifacts'),item.siteId,item.releaseId)});
      created.push(id);
      await writeFile(join(root,'reconstruction-resources.json'),JSON.stringify({containers:created}),{mode:0o600});
      let healthy=false;
      for(let i=0;i<45;i++) { if(await checkCandidate(port,'localhost') && await checkCandidate(port,item.host,'/')) {healthy=true;break;} await new Promise(r=>setTimeout(r,1000)); }
      if(!healthy) throw new Error('restored_runtime_health_failed');
      const deploymentId=randomUUID();
      await connection.query('INSERT INTO "Deployment" (id,"siteId","releaseId","artifactId","imageDigest",host,"healthStatus","routeRevision","activatedAt") VALUES ($1,$2,$3,$4,$5,$6,\'healthy\',$7,now())',[deploymentId,item.siteId,item.releaseId,row.artifactId,row.imageDigest,item.host,item.routeRevision]);
      await connection.query('UPDATE "ActiveDeployment" SET id=$1,"activatedAt"=now() WHERE "siteId"=$2',[deploymentId,item.siteId]);
      await connection.query('UPDATE "Site" SET "credentialHash"=$1 WHERE id=$2',[createHash('sha256').update(credential).digest('hex'),item.siteId]);
      const aliases=(await connection.query('SELECT hostname FROM "Domain" WHERE "siteId"=$1 AND enabled=true AND "ownershipStatus"=\'verified\' AND "dnsStatus"=\'ready\' AND "certificateStatus"=\'ready\' AND hostname<>$2',[item.siteId,item.host])).rows.map(r=>r.hostname);
      return {siteId:item.siteId,releaseId:item.releaseId,revision:item.routeRevision,host:item.host,redirectHosts:aliases,containerId:id,port,token:randomBytes(32).toString('hex')};
    });
    // Writers/traffic are still offline. A crash never authorizes serving saved old physical IDs.
    await writeFile(join(root,'routes.pending.json'),JSON.stringify(rebuilt),{mode:0o600,flag:'wx'});
    commitAttempted=true;
    await connection.query('COMMIT'); committed=true;
    await rename(join(root,'routes.pending.json'),join(root,'routes.json'));
    await writeFile(join(root,'restore-private.json'),JSON.stringify({...receipt,status:'ready',containers:created}),{mode:0o600});
    return {count:created.length};
  } catch(error) {
    await client?.query('ROLLBACK').catch(()=>undefined);
    const residual:string[]=[];
    if(!commitAttempted) for(const id of created) {
      try { await docker.request({method:'DELETE',path:`/containers/${id}?force=true`}); } catch { residual.push(id); }
    }
    // If SQL committed, leave owned instances and the pending route file for operator inspection.
    await writeFile(join(root,'reconstruction-failure.json'),JSON.stringify({committed,commitAttempted,containers:created,residual}),{mode:0o600});
    throw error;
  } finally { await lock.close(); client?.release(); await pool.end(); }
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) restoreDeployments(process.argv[2]).then(result=>console.log(JSON.stringify(result))).catch(()=>{console.error('isolated_reconstruction_failed; inspect private restore directory');process.exitCode=1;});
