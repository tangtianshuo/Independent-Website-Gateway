import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, request } from 'node:http';
import { Pool } from 'pg';
import { describe, it, expect } from 'vitest';
import { provisionSite } from '../src/provisioning';
import { reserveDomain, checkReservedDomain, mutateDomain } from '../src/domains';
import { processDomainChange, projectReservedDomains } from '../../../packages/worker/src/domain-changes';
import { createLocalRouter } from '../../../packages/worker/src/runtime';
import { createPublishOperation } from '../src/publish';
import { readDomainState } from '../../../packages/traffic/src/state';
import { scheduleWorkerOperations } from '../../../packages/worker/src/scheduling';
import { failPublishOperation } from '../../../packages/worker/src/operations';
import { createTrafficProxy } from '../../../packages/traffic/src/index';
const url = process.env.GATEWAY_TEST_DATABASE_URL;
(url ? describe : describe.skip)('Gateway domain lifecycle SQL', () => {
  it('keeps source isolation, exact default identity, queued primary truth, failed route rollback and crash replay', async () => {
    const pool = new Pool({connectionString: url});
    const directory = await mkdtemp(join(tmpdir(),'domain-lifecycle-'));
    const instance = randomUUID();
    process.env.CMS_SERVICE_SECRET='test-secret'; process.env.CMS_INSTANCE_ID=instance;
    const input={cmsWorkspaceId:randomUUID(),cmsSiteId:randomUUID(),name:'one',requestKey:randomUUID()};
    const a=await provisionSite(pool,instance,input,'sites.localhost');
    const b=await provisionSite(pool,instance,{...input,cmsWorkspaceId:randomUUID(),cmsSiteId:randomUUID(),requestKey:randomUUID()},'sites.localhost');
    const req=(body?:unknown)=>new Request('http://localhost',{method:'POST',headers:{authorization:'Bearer test-secret','X-CMS-Workspace':input.cmsWorkspaceId,'X-CMS-Site':input.cmsSiteId},body:JSON.stringify(body??{})});
    try {
      await projectReservedDomains(pool,join(directory,'domains.json'));
      expect((await readDomainState(join(directory,'domains.json'))).has(new URL(a.siteUrl).hostname)).toBe(true);
      const id=(await pool.query('SELECT "defaultDomainId" FROM "SourceSiteBinding" WHERE "siteId"=$1',[a.siteId])).rows[0].defaultDomainId;
      const check=async(domainId:string,ready=true)=>checkReservedDomain(req(),a.siteId,domainId,pool,async record=>({ownership:record.platformOwned || !!record.verificationTokenHash,dns:true,https:ready}));
      expect((await check(id)).status).toBe(200);
      expect((await pool.query('SELECT * FROM "ActiveDeployment" WHERE "siteId"=$1',[a.siteId])).rowCount).toBe(0);
      const responses=await Promise.all([reserveDomain(req({hostname:'custom.example.com'}),a.siteId,pool),reserveDomain(req({hostname:'custom.example.com'}),a.siteId,pool)]);
      expect(responses.map(x=>x.status).sort()).toEqual([201,409]);
      const added=await responses.find(x=>x.status===201)!.json();
      expect(added.txtValue).toMatch(/^cms-verify=/);
      const customId=added.id;
      expect((await mutateDomain(req(),b.siteId,customId,'primary',pool)).status).toBe(404);
      expect((await mutateDomain(req(),a.siteId,customId,'primary',pool)).status).toBe(409);
      await check(customId);
      expect((await mutateDomain(req(),a.siteId,id,'remove',pool)).status).toBe(409);
      expect((await mutateDomain(req(),a.siteId,customId,'primary',pool)).status).toBe(202);
      expect((await pool.query('SELECT "isPrimary" FROM "Domain" WHERE "id"=$1',[id])).rows[0].isPrimary).toBe(true);
      expect((await createPublishOperation(req({releaseId:'release',idempotencyKey:'pending-domain',expectedRevision:0}),a.siteId,pool)).status).toBe(409);
      // No active deployment: the worker commits the primary without creating content routing.
      const router=createLocalRouter(join(directory,'routes.json'));
      expect(await processDomainChange(pool,router,async()=>true)).toBe(true);
      expect(await router.readRoute(a.siteId)).toBeUndefined();
      expect((await pool.query('SELECT "isPrimary" FROM "Domain" WHERE "id"=$1',[customId])).rows[0].isPrimary).toBe(true);
      expect(await provisionSite(pool,instance,input,'different.example')).toEqual(a);
      await check(customId,false); // Failed recheck must not change the committed active host on a later failed switch.
      expect((await mutateDomain(req(),a.siteId,id,'primary',pool)).status).toBe(202);
      await router.applyRoute(a.siteId,1,12345,'custom.example.com','old-token','container','release');
      // Route-only fixture tests failure protection; full publication is covered by the e2e runner.
      let verifications=0;
      expect(await processDomainChange(pool,router,async()=>++verifications!==2)).toBe(true);
      expect(verifications).toBe(3);
      expect((await router.readRoute(a.siteId))?.host).toBe('custom.example.com');
      expect((await pool.query('SELECT "isPrimary" FROM "Domain" WHERE "id"=$1',[customId])).rows[0].isPrimary).toBe(true);
      expect((await pool.query('SELECT "status" FROM "DomainChange" WHERE "siteId"=$1',[a.siteId])).rows[0].status).toBe('failed');
      expect((await mutateDomain(req(),a.siteId,id,'primary',pool)).status).toBe(202);
      // Simulate durable route update before SQL commit; pending intent must replay to convergence.
      const upstream=createServer((_request,response)=>response.end('existing published content'));
      await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
      const port=(upstream.address() as {port:number}).port;
      await router.applyRoute(a.siteId,1,port,new URL(a.siteUrl).hostname,'crash-token','container','release',['custom.example.com']);
      const restarted=createLocalRouter(join(directory,'routes.json'));
      try {
        await restarted.recover(async()=>[{siteId:a.siteId,releaseId:'release',routeRevision:1}],async()=>true);
        await processDomainChange(pool,restarted,async()=>true);
        expect((await restarted.readRoute(a.siteId))?.host).toBe(new URL(a.siteUrl).hostname);
      } finally {upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));}
      expect((await pool.query('SELECT "status","error" FROM "DomainChange" WHERE "siteId"=$1',[a.siteId])).rows[0]).toEqual({status:'succeeded',error:null});
      expect((await pool.query('SELECT "isPrimary" FROM "Domain" WHERE "id"=$1',[id])).rows[0].isPrimary).toBe(true);
      expect((await router.readRoute(a.siteId))?.host).toBe(new URL(a.siteUrl).hostname);
      await check(customId);
      // A lost COMMIT acknowledgement must retain a possibly committed route.
      expect((await mutateDomain(req(),a.siteId,customId,'primary',pool)).status).toBe(202);
      const uncertain={connect:async()=>{const client=await pool.connect();return {query:async(sql:string,values?:unknown[])=>{const result=await client.query(sql,values);if(sql==='COMMIT')throw Error('lost commit acknowledgement');return result;},release:()=>client.release()};}};
      expect(await processDomainChange(uncertain as unknown as Pool,restarted,async()=>true)).toBe(true);
      expect((await restarted.readRoute(a.siteId))?.host).toBe('custom.example.com');
      expect((await pool.query('SELECT "status" FROM "DomainChange" WHERE "siteId"=$1',[a.siteId])).rows[0].status).toBe('succeeded');
      expect((await pool.query('SELECT "isPrimary" FROM "Domain" WHERE "id"=$1',[customId])).rows[0].isPrimary).toBe(true);
      const alias=await (await reserveDomain(req({hostname:'alias.example.com'}),a.siteId,pool)).json();await check(alias.id);
      expect((await mutateDomain(req({enabled:false}),a.siteId,alias.id,'state',pool)).status).toBe(202);
      await processDomainChange(pool,restarted,async()=>true);
      expect((await pool.query('SELECT "enabled" FROM "Domain" WHERE "id"=$1',[alias.id])).rows[0].enabled).toBe(false);
      expect((await mutateDomain(req(),a.siteId,alias.id,'remove',pool)).status).toBe(202);
      await processDomainChange(pool,restarted,async()=>true);
      expect((await pool.query('SELECT 1 FROM "Domain" WHERE "id"=$1',[alias.id])).rowCount).toBe(0);
    } finally {
      await pool.query('DELETE FROM "DomainChange" WHERE "siteId"=ANY($1::uuid[])',[[a.siteId,b.siteId]]);
      await pool.query('DELETE FROM "SourceSiteBinding" WHERE "instanceId"=$1',[instance]);
      await pool.query('DELETE FROM "SourceWorkspaceBinding" WHERE "instanceId"=$1',[instance]);
      for(const site of [a,b]) {await pool.query('DELETE FROM "Domain" WHERE "siteId"=$1',[site.siteId]);await pool.query('DELETE FROM "Site" WHERE "id"=$1',[site.siteId]);await pool.query('DELETE FROM "Workspace" WHERE "id"=$1',[site.workspaceId]);}
      await pool.end(); await rm(directory,{recursive:true,force:true});
    }
  });
});

// Real PostgreSQL, production durable router and public traffic; only the runtime
// container is represented by a host-sensitive loopback server in these faults.
interface PublishedDomainFixture {
  pool: Pool; instance: string;
  site: Awaited<ReturnType<typeof provisionSite>>;
  req: (body?: unknown) => Request;
  check: (id: string, https?: boolean) => Promise<Response>;
  defaultId: string; primaryId: string; aliasId: string;
  defaultHost: string; primaryHost: string; aliasHost: string;
  unhealthy: Set<string>; port: number; state: string;
  router: ReturnType<typeof createLocalRouter>;
  fetchHost: (host: string) => Promise<{status:number;location?:string;body:string}>;
  status: () => Promise<{primary:string;deployment:string;intent:string;durable:string}>;
  active: () => Promise<{siteId:string;releaseId:string;routeRevision:number;host:string}[]>;
}
async function withPublishedDomains(run: (fixture: PublishedDomainFixture) => Promise<void>) {
  const pool = new Pool({connectionString: url});
  const directory = await mkdtemp(join(tmpdir(), 'domain-fault-'));
  const state = join(directory, 'routes.json');
  const instance = randomUUID(), input = {cmsWorkspaceId:randomUUID(),cmsSiteId:randomUUID(),name:'fault',requestKey:randomUUID()};
  process.env.CMS_SERVICE_SECRET='test-secret'; process.env.CMS_INSTANCE_ID=instance;
  const site = await provisionSite(pool,instance,input,'sites.localhost');
  const defaultHost = new URL(site.siteUrl).hostname, primaryHost='primary-'+site.siteId+'.example.test', aliasHost='alias-'+site.siteId+'.example.test';
  const req=(body?:unknown)=>new Request('http://localhost',{method:'POST',headers:{authorization:'Bearer test-secret','X-CMS-Workspace':input.cmsWorkspaceId,'X-CMS-Site':input.cmsSiteId},body:JSON.stringify(body??{})});
  const unhealthy = new Set<string>();
  const upstream = createServer((req,res)=>{res.writeHead(unhealthy.has(req.headers.host || '')?503:200);res.end('published '+req.headers.host);});
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const port=(upstream.address() as {port:number}).port;
  const router=createLocalRouter(state), proxy=createTrafficProxy(state);await proxy.listen(0);
  try {
    const defaultId=(await pool.query('SELECT "defaultDomainId" FROM "SourceSiteBinding" WHERE "siteId"=$1',[site.siteId])).rows[0].defaultDomainId;
    const primaryId=(await (await reserveDomain(req({hostname:primaryHost}),site.siteId,pool)).json()).id;
    const aliasId=(await (await reserveDomain(req({hostname:aliasHost}),site.siteId,pool)).json()).id;
    const check=async(id:string,https=true)=>checkReservedDomain(req(),site.siteId,id,pool,async()=>({ownership:true,dns:true,https}));
    for(const id of [defaultId,primaryId,aliasId])await check(id);
    await mutateDomain(req(),site.siteId,primaryId,'primary',pool);await processDomainChange(pool,router);
    const deploymentId=randomUUID(), artifactId=randomUUID();
    await pool.query('INSERT INTO "Release" ("id","siteId","releaseId","checksum","metadata") VALUES ($1,$2,$3,$4,$5)',[randomUUID(),site.siteId,'release','test','{}']);
    await pool.query('INSERT INTO "ReleaseArtifact" ("id","siteId","releaseId","checksum","updatedAt") VALUES ($1,$2,$3,$4,now())',[artifactId,site.siteId,'release','test']);
    await pool.query('INSERT INTO "Deployment" ("id","siteId","releaseId","artifactId","imageDigest","host","routeRevision") VALUES ($1,$2,$3,$4,$5,$6,1)',[deploymentId,site.siteId,'release',artifactId,'test',primaryHost]);
    await pool.query('INSERT INTO "ActiveDeployment" ("id","siteId","releaseId","imageDigest","routeRevision") VALUES ($1,$2,$3,$4,1)',[deploymentId,site.siteId,'release','test']);
    await router.applyRoute(site.siteId,1,port,primaryHost,'committed','container','release',[defaultHost,aliasHost]);
    const fetchHost=(host:string)=>new Promise<{status:number;location?:string;body:string}>((resolve,reject)=>{
      const req=request({hostname:'127.0.0.1',port:proxy.port(),path:'/catalog?sort=new',headers:{host}},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode!,location:res.headers.location,body}));});req.on('error',reject);req.end();
    });
    const status=async()=>({
      primary:(await pool.query('SELECT "hostname" FROM "Domain" WHERE "siteId"=$1 AND "isPrimary"=true',[site.siteId])).rows[0].hostname,
      deployment:(await pool.query('SELECT "host" FROM "Deployment" WHERE "id"=$1',[deploymentId])).rows[0].host,
      intent:(await pool.query('SELECT "status" FROM "DomainChange" WHERE "siteId"=$1',[site.siteId])).rows[0].status,
      durable:JSON.parse(await readFile(state,'utf8')).routes.find((row:{siteId:string})=>row.siteId===site.siteId).host,
    });
    const active=async()=> (await pool.query('SELECT active."siteId",active."releaseId",active."routeRevision",deployment."host" FROM "ActiveDeployment" active JOIN "Deployment" deployment ON deployment."id"=active."id" WHERE active."siteId"=$1',[site.siteId])).rows;
    await run({pool,instance,site,req,check,defaultId,primaryId,aliasId,defaultHost,primaryHost,aliasHost,unhealthy,port,router,state,fetchHost,status,active});
  } finally {
    await proxy.close();upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));
    for(const table of ['DomainChange','PublishOperation','Publication','ActiveDeployment','Deployment','ReleaseArtifact','Release','SourceSiteBinding','Domain'])await pool.query('DELETE FROM "'+table+'" WHERE "siteId"=$1',[site.siteId]);
    await pool.query('DELETE FROM "SourceWorkspaceBinding" WHERE "instanceId"=$1',[instance]);
    await pool.query('DELETE FROM "Site" WHERE "id"=$1',[site.siteId]);await pool.query('DELETE FROM "Workspace" WHERE "id"=$1',[site.workspaceId]);
    await pool.end();await rm(directory,{recursive:true,force:true});
  }
}
(url ? describe : describe.skip)('domain intent durable/public consistency',()=>{
  it('restores the healthy committed host after crash when desired host is unhealthy',async()=>withPublishedDomains(async f=>{
    await mutateDomain(f.req(),f.site.siteId,f.defaultId,'primary',f.pool);
    await f.router.applyRoute(f.site.siteId,1,f.port,f.defaultHost,'crashed','container','release',[f.primaryHost,f.aliasHost]);
    f.unhealthy.add(f.defaultHost);
    const restarted=createLocalRouter(f.state);await restarted.recover(f.active,async()=>true);
    await processDomainChange(f.pool,restarted);
    expect(await f.status()).toEqual({primary:f.primaryHost,deployment:f.primaryHost,intent:'failed',durable:f.primaryHost});
    expect(await f.fetchHost(f.primaryHost)).toMatchObject({status:200,body:'published '+f.primaryHost});
    expect(await f.fetchHost(f.defaultHost)).toMatchObject({status:301,location:'https://'+f.primaryHost+'/catalog?sort=new'});
  }));
  it('keeps an unrecoverable active route intent pending until safe recovery is possible',async()=>withPublishedDomains(async f=>{
    await mutateDomain(f.req(),f.site.siteId,f.defaultId,'primary',f.pool);
    await f.router.applyRoute(f.site.siteId,1,f.port,f.defaultHost,'crashed','container','release',[f.primaryHost]);
    f.unhealthy.add(f.defaultHost);f.unhealthy.add(f.primaryHost);
    const restarted=createLocalRouter(f.state);await restarted.recover(f.active,async()=>true);
    expect(await processDomainChange(f.pool,restarted)).toBe(true);
    expect(await f.status()).toEqual({primary:f.primaryHost,deployment:f.primaryHost,intent:'pending',durable:f.defaultHost});
    f.unhealthy.delete(f.primaryHost);
    await f.pool.query('UPDATE "DomainChange" SET "retryAfter"=now() WHERE "siteId"=$1',[f.site.siteId]);
    await processDomainChange(f.pool,restarted);
    expect(await f.status()).toEqual({primary:f.primaryHost,deployment:f.primaryHost,intent:'failed',durable:f.primaryHost});
    expect((await f.fetchHost(f.primaryHost)).status).toBe(200);
  }));
  for(const operation of ['state','remove'] as const)it('preserves committed primary after failed recheck and alias '+operation,async()=>withPublishedDomains(async f=>{
    await f.check(f.primaryId,false);
    expect((await mutateDomain(f.req({enabled:false}),f.site.siteId,f.aliasId,operation,f.pool)).status).toBe(202);
    await processDomainChange(f.pool,f.router);
    expect(await f.status()).toEqual({primary:f.primaryHost,deployment:f.primaryHost,intent:'succeeded',durable:f.primaryHost});
    expect((await f.fetchHost(f.primaryHost)).status).toBe(200);
    expect(await f.fetchHost(f.defaultHost)).toMatchObject({status:301,location:'https://'+f.primaryHost+'/catalog?sort=new'});
    expect((await f.fetchHost(f.aliasHost)).status).toBe(404);
    const alias=await f.pool.query('SELECT "enabled" FROM "Domain" WHERE "id"=$1',[f.aliasId]);
    if(operation==='remove')expect(alias.rowCount).toBe(0);else expect(alias.rows[0].enabled).toBe(false);
  }));
});


(url ? describe : describe.skip)('domain recovery scheduler isolation',()=>{
  it('defers unavailable A while B publication and domain work progress, then recovers A',async()=>withPublishedDomains(async a=>withPublishedDomains(async b=>{
    process.env.CMS_INSTANCE_ID=a.instance;
    expect((await mutateDomain(a.req(),a.site.siteId,a.defaultId,'primary',a.pool)).status).toBe(202);
    expect((await createPublishOperation(a.req({releaseId:'release',idempotencyKey:'blocked-a',expectedRevision:0}),a.site.siteId,a.pool)).status).toBe(409);
    await a.router.applyRoute(a.site.siteId,1,a.port,a.defaultHost,'crashed','container','release',[a.primaryHost]);
    a.unhealthy.add(a.defaultHost);a.unhealthy.add(a.primaryHost);
    await a.router.applyRoute(b.site.siteId,1,b.port,b.primaryHost,'committed-b','container-b','release',[b.defaultHost,b.aliasHost]);
    const router=createLocalRouter(a.state);
    const active=async()=>[...await a.active(),...await b.active()];
    await router.recover(active,async()=>true);
    process.env.CMS_INSTANCE_ID=b.instance;
    const publish=await createPublishOperation(b.req({releaseId:'release',idempotencyKey:'progress-b',expectedRevision:0}),b.site.siteId,b.pool);
    expect(publish.status).toBe(201);
    const workerId=randomUUID();
    // This is the exact production domain-then-publication sequence, without a
    // test-local catch that could mask publication being skipped by an error.
    const claim=await scheduleWorkerOperations(a.pool,router,workerId);
    expect(claim?.siteId).toBe(b.site.siteId);
    expect((await a.status()).intent).toBe('pending');
    expect((await a.pool.query('SELECT "retryAfter">clock_timestamp() AS deferred,"error" FROM "DomainChange" WHERE "siteId"=$1',[a.site.siteId])).rows[0]).toEqual({deferred:true,error:'Active route unavailable on this worker; recovery required'});
    process.env.CMS_INSTANCE_ID=a.instance;
    expect((await createPublishOperation(a.req({releaseId:'release',idempotencyKey:'still-blocked-a',expectedRevision:0}),a.site.siteId,a.pool)).status).toBe(409);
    process.env.CMS_INSTANCE_ID=b.instance;
    expect((await b.pool.query('SELECT "attempts","leaseOwner" FROM "PublishOperation" WHERE "id"=$1',[claim!.id])).rows[0]).toEqual({attempts:1,leaseOwner:workerId});
    expect(await failPublishOperation(b.pool,{operationId:claim!.id,workerId,attempts:claim!.attempts,leaseUntil:claim!.leaseUntil,failureCode:'CANDIDATE_CREATE_FAILED'})).toBe(true);
    expect((await mutateDomain(b.req({enabled:false}),b.site.siteId,b.aliasId,'state',b.pool)).status).toBe(202);
    // A stays the oldest pending intent. A later domain operation must still run.
    expect(await scheduleWorkerOperations(a.pool,router,workerId)).toBeNull();
    expect((await b.pool.query('SELECT "status" FROM "DomainChange" WHERE "siteId"=$1',[b.site.siteId])).rows[0].status).toBe('succeeded');
    expect((await a.status()).intent).toBe('pending');
    expect((await a.fetchHost(b.primaryHost)).status).toBe(200);
    expect((await a.fetchHost(b.aliasHost)).status).toBe(404);
    const bBeforeRecovery=await router.readRoute(b.site.siteId);
    a.unhealthy.delete(a.primaryHost);
    // Let the durable retry become eligible; production recovery runs on retry.
    await a.pool.query('UPDATE "DomainChange" SET "retryAfter"=now() WHERE "siteId"=$1',[a.site.siteId]);
    expect(await scheduleWorkerOperations(a.pool,router,workerId)).toBeNull();
    expect(await a.status()).toEqual({primary:a.primaryHost,deployment:a.primaryHost,intent:'failed',durable:a.primaryHost});
    expect((await a.fetchHost(a.primaryHost)).status).toBe(200);
    expect(await a.fetchHost(a.defaultHost)).toMatchObject({status:301,location:'https://'+a.primaryHost+'/catalog?sort=new'});
    expect(await router.readRoute(b.site.siteId)).toEqual(bBeforeRecovery);
    expect(JSON.parse(await readFile(a.state,'utf8')).routes.find((route:{siteId:string})=>route.siteId===b.site.siteId)).toEqual(bBeforeRecovery);
    expect((await a.fetchHost(b.primaryHost)).status).toBe(200);
    expect((await a.fetchHost(b.aliasHost)).status).toBe(404);
  })));
});
