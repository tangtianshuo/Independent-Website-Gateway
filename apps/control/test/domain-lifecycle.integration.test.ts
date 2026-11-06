import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { Pool } from 'pg';
import { describe, it, expect } from 'vitest';
import { provisionSite } from '../src/provisioning';
import { reserveDomain, checkReservedDomain, mutateDomain } from '../src/domains';
import { processDomainChange, projectReservedDomains } from '../../../packages/worker/src/domain-changes';
import { createLocalRouter } from '../../../packages/worker/src/runtime';
import { createPublishOperation } from '../src/publish';
import { readDomainState } from '../../../packages/traffic/src/state';
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
      expect(await processDomainChange(pool,router,async()=>++verifications===1)).toBe(true);
      expect(verifications).toBe(2);
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
      await expect(processDomainChange(uncertain as unknown as Pool,restarted,async()=>true)).rejects.toThrow('lost commit acknowledgement');
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
