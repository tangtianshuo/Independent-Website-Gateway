import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { challengeResponse } from './domain-challenge.js';
import { writeDomainState } from './state.js';
import { createTrafficProxy } from './index.js';

test('reserved hosts verify without deployment using CMS challengeSignature protocol', () => {
  const signature = challengeResponse('new.sites.localhost', 'nonce-123', new Set(['new.sites.localhost']), 'test-only');
  assert.equal(signature, createHmac('sha256', 'test-only').update('cms-domain-v1:new.sites.localhost:nonce-123').digest('hex'));
  assert.equal(challengeResponse('foreign.localhost', 'nonce-123', new Set(['new.sites.localhost']), 'test-only'), null);
  for (const nonce of ['', 'a'.repeat(129), '../bad', 'a b']) assert.throws(() => challengeResponse('new.sites.localhost', nonce, new Set(['new.sites.localhost']), 'test-only'));
});

test('challenge uses durable reservations only, rejects bad nonce/Host, and never grants content routes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-domain-'));
  const domains = join(directory, 'domains.json');
  await writeDomainState(domains, ['new.sites.localhost']);
  const proxy = createTrafficProxy(join(directory, 'routes.json'), { domainStatePath: domains, secret: 'test-only' });
  await proxy.listen(0);
  const get = (host: string, path: string) => new Promise<{status: number; body: string}>((resolve, reject) => {
    const req = request({hostname: '127.0.0.1', port: proxy.port(), headers: {host}, path}, res => {
      let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({status: res.statusCode!, body}));
    }); req.on('error', reject); req.end();
  });
  try {
    assert.equal((await get('new.sites.localhost', '/.well-known/cms-domain-challenge?nonce=nonce-123')).status, 200);
    assert.equal((await get('new.sites.localhost', '/')).status, 404);
    const duplicateStatus = await new Promise<number>((resolve, reject) => { const req=request({hostname:'127.0.0.1',port:proxy.port(),path:'/.well-known/cms-domain-challenge?nonce=nonce-123',headers:['Host','new.sites.localhost','Host','foreign.localhost']},res=>{res.resume();resolve(res.statusCode!);});req.on('error',reject);req.end(); });
    assert.equal(duplicateStatus, 400);
    assert.equal((await get('foreign.localhost', '/.well-known/cms-domain-challenge?nonce=nonce-123')).status, 404);
    for (const query of ['nonce=', 'nonce=a%20b', `nonce=${'a'.repeat(129)}`, 'nonce=a&nonce=b']) assert.equal((await get('new.sites.localhost', `/.well-known/cms-domain-challenge?${query}`)).status, 400);
    assert.equal((await get('new.sites.localhost.evil', '/.well-known/cms-domain-challenge?nonce=nonce-123')).status, 404);
    await writeDomainState(domains, []);
    assert.equal((await get('new.sites.localhost', '/.well-known/cms-domain-challenge?nonce=nonce-123')).status, 404);
  } finally { await proxy.close(); await rm(directory, {recursive: true, force: true}); }
});
