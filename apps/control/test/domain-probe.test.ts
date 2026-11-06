import { describe, it, expect } from 'vitest';
import { createHmac, createHash } from 'node:crypto';
import { probeDomain } from '../src/domain-probe';
const signature = (host: string, nonce: string) => createHmac('sha256', 'secret').update(`cms-domain-v1:${host}:${nonce}`).digest('hex');
describe('prepublication domain probe', () => {
  const options = {secret: 'secret', lookup: async () => [{address: '8.8.8.8', family: 4}], request: async (host: string, _address: string, nonce: string) => signature(host, nonce)};
  it('requires HTTPS even when platform ownership is trusted', async () => {
    expect(await probeDomain({hostname: 'new.example.com', platformOwned: true}, options)).toMatchObject({ownership: true, dns: true, https: true});
    expect(await probeDomain({hostname: 'new.example.com', platformOwned: true}, {...options, request: async () => {throw Error('certificate invalid');}})).toMatchObject({ownership: true, dns: true, https: false});
  });
  it('requires the custom TXT and rejects private DNS before network I/O', async () => {
    const record = {hostname: 'custom.example.com', platformOwned: false, verificationTokenHash: createHash('sha256').update('proof').digest('hex')};
    expect(await probeDomain(record, {...options, resolveTxt: async () => [['wrong']]})).toMatchObject({ownership: false, https: true});
    expect(await probeDomain(record, {...options, resolveTxt: async () => [['proof']]})).toMatchObject({ownership: true, https: true});
    let requested = false;
    expect(await probeDomain(record, {...options, resolveTxt: async () => [['proof']], lookup: async () => [{address:'127.0.0.1',family:4}], request: async () => {requested = true; return '';}})).toMatchObject({dns: false, https: false});
    expect(requested).toBe(false);
  });
});
