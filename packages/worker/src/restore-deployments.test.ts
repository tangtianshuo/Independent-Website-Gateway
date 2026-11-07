import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restoreRouteState } from '../../traffic/dist/state.js';
import { rebuildRoutes } from './restore-deployments.js';

const old = { siteId: 'site', revision: 2, port: 12345, host: 'site.test', token: 'old', containerId: 'dead', releaseId: 'r2' };
test('restore refuses replacing newer current or previous revisions and missing sites', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'restore-routes-'));
  try {
    const source = join(dir, 'source'), target = join(dir, 'target');
    await writeFile(source, JSON.stringify({ routes: [old], previous: [] }));
    for (const state of [{routes:[{...old, revision:3}],previous:[]},{routes:[old],previous:[{...old,revision:4}]},{routes:[{...old,siteId:'other'}],previous:[]}]) {
      const bytes=JSON.stringify(state); await writeFile(target, bytes);
      await assert.rejects(restoreRouteState(source,target), /newer_route_revision/);
      assert.equal(await readFile(target,'utf8'),bytes);
    }
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('rebuild serves fresh active identity while preserving archived unresolved snapshots', async () => {
  const unresolved = {...old,siteId:'unresolved',revision:9};
  const snapshot={routes:[old,unresolved],previous:[{...old,releaseId:'r1',revision:1}]};
  const result=await rebuildRoutes(snapshot,[{siteId:'site',releaseId:'r2',routeRevision:2,host:'site.test'}],async()=>({...old,port:23456,containerId:'new',token:'fresh'}));
  assert.equal(result.routes[0].containerId,'new'); assert.equal(result.routes[0].revision,2);
  assert.equal(result.routes.length,1); assert.deepEqual(result.previous,[]);
  assert.deepEqual(snapshot.routes,[old,unresolved]); assert.deepEqual(snapshot.previous,[{...old,releaseId:'r1',revision:1}]);
});

test('rebuild rejects reused container or port, mismatched release and failed health',async()=>{
  for (const candidate of [old,{...old,containerId:'new'},{...old,containerId:'new',port:23456,releaseId:'wrong'}]) {
    await assert.rejects(rebuildRoutes({routes:[old],previous:[]},[{siteId:'site',releaseId:'r2',routeRevision:2,host:'site.test'}],async()=>candidate),/invalid_rebuilt_route/);
  }
  await assert.rejects(rebuildRoutes({routes:[old],previous:[]},[{siteId:'site',releaseId:'r2',routeRevision:2,host:'site.test'}],async()=>{throw Error('health_failed');}),/health_failed/);
});

test('a newer previous entry cannot conceal a regressing current route', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'restore-regression-'));
 try {
  const source=join(dir,'source'),target=join(dir,'target');
  await writeFile(source,JSON.stringify({routes:[old],previous:[{...old,revision:9}]}));
  await writeFile(target,JSON.stringify({routes:[{...old,revision:3}],previous:[]}));
  await assert.rejects(restoreRouteState(source,target),/newer_route_revision/);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('duplicate source routes cannot conceal a regressing first route',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'restore-duplicate-'));
 try {
  const source=join(dir,'source'),target=join(dir,'target');
  await writeFile(source,JSON.stringify({routes:[old,{...old,revision:9}],previous:[]}));
  await writeFile(target,JSON.stringify({routes:[{...old,revision:3}],previous:[]}));
  await assert.rejects(restoreRouteState(source,target),/Invalid route state/);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('reconstruction requires receipt-bound scope and explicitly configured intake before Docker', async () => {
  const { restoreRuntimeConfig } = await import('./restore-deployments.js');
  const runtimeScope = 'restore-' + 'a'.repeat(24);
  const receipt = { runtimeScope };
  assert.throws(() => restoreRuntimeConfig(receipt, {}), /scope_required/);
  assert.throws(() => restoreRuntimeConfig(receipt, { GATEWAY_RUNTIME_SCOPE: runtimeScope }), /intake_origin_required/);
  for (const origin of ['http://external.example', 'https://intake.example/path', 'https://user:secret@intake.example']) {
    assert.throws(() => restoreRuntimeConfig(receipt, { GATEWAY_RUNTIME_SCOPE: runtimeScope, NUXT_PUBLIC_INGEST_ORIGIN: origin }), /intake origin/);
  }
  assert.deepEqual(restoreRuntimeConfig(receipt, { GATEWAY_RUNTIME_SCOPE: runtimeScope, NUXT_PUBLIC_INGEST_ORIGIN: 'http://127.0.0.1:12345' }), { runtimeScope, ingestOrigin: 'http://127.0.0.1:12345' });
});
