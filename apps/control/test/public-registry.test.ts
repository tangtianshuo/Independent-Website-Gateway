import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '@gateway/contracts';
import { loadPublicTemplate, parseRegistryIndex } from '../src/public-registry';

const record = {
  schemaVersion: 1, id: 'aeroframe', version: '1.0.1',
  manifestChecksum: `sha256:${'a'.repeat(64)}`,
  imageRepository: 'ghcr.io/tangtianshuo/independent-website-templates/aeroframe',
  imageDigest: `sha256:${'b'.repeat(64)}`, sourceCommit: 'c'.repeat(40),
  manifestPath: 'templates/aeroframe/1.0.1/template.json', status: 'available',
};

describe('public template registry', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('accepts only schema 1 records for the exact fixed GHCR repository and manifest path', () => {
    expect(parseRegistryIndex({ schemaVersion: 1, records: [record] })).toEqual([record]);
    expect(() => parseRegistryIndex({ schemaVersion: 1, records: [{ ...record, imageRepository: 'ghcr.io/attacker/image' }] })).toThrow();
    expect(() => parseRegistryIndex({ schemaVersion: 1, records: [{ ...record, manifestPath: '../template.json' }] })).toThrow();
  });

  it('rejects duplicated template versions', () => {
    expect(() => parseRegistryIndex({ schemaVersion: 1, records: [record, record] })).toThrow(/Duplicate/);
  });

  it.each(['registry_commit', 'registry_index', 'manifest'])('identifies a transport failure at %s without retaining private error text', async (stage) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const current = url.includes('/commits/') ? 'registry_commit' : url.endsWith('/index.json') ? 'registry_index' : 'manifest';
      if (current === stage) throw new TypeError('private token=secret', { cause: { code: 'ECONNRESET' } });
      if (current === 'registry_commit') return Response.json({ sha: 'd'.repeat(40) });
      return Response.json({ schemaVersion: 1, records: [record] });
    }));
    const error = await loadPublicTemplate('aeroframe', '1.0.1').catch(cause => cause);
    expect(error).toMatchObject({ diagnostic: { stage, reason: 'network', networkCode: 'ECONNRESET', elapsedMs: expect.any(Number) } });
    expect(JSON.stringify(error)).not.toMatch(/private|token|secret/);
  });

  it.each([
    [403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1793241216' }, 'rate_limited'],
    [429, { 'retry-after': '30' }, 'rate_limited'],
    [503, {}, 'http_error'],
  ])('distinguishes upstream HTTP %s and cancels its unused response', async (status, headers, reason) => {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: Number(status), headers: headers as HeadersInit })));
    const error = await loadPublicTemplate('aeroframe', '1.0.1').catch(cause => cause);
    expect(error).toMatchObject({ diagnostic: { stage: 'registry_commit', reason, status } });
    if (status === 403) expect(error.diagnostic).toMatchObject({ rateLimitRemaining: 0, rateLimitReset: 1793241216 });
    if (status === 429) expect(error.diagnostic.retryAfterSeconds).toBe(30);
    expect(cancelled).toBe(true);
  });

  it('identifies a response-body timeout separately from a network rejection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.error(new DOMException('private timeout details', 'TimeoutError')); },
    }))));
    await expect(loadPublicTemplate('aeroframe', '1.0.1')).rejects.toMatchObject({ diagnostic: { stage: 'registry_commit', reason: 'timeout' } });
  });

  it('identifies malformed JSON and rejects response bodies beyond the size limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private upstream token=secret')));
    const malformed = await loadPublicTemplate('aeroframe', '1.0.1').catch(cause => cause);
    expect(malformed).toMatchObject({ diagnostic: { stage: 'registry_commit', reason: 'invalid_json' } });
    expect(JSON.stringify(malformed)).not.toMatch(/private|token|secret/);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1))));
    await expect(loadPublicTemplate('aeroframe', '1.0.1')).rejects.toMatchObject({ diagnostic: { stage: 'registry_commit', reason: 'response_too_large' } });
  });

  it('keeps an invalid registry commit distinct from a transport failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(null)));
    await expect(loadPublicTemplate('aeroframe', '1.0.1')).rejects.toMatchObject({ diagnostic: { stage: 'registry_commit', reason: 'invalid_commit' } });
  });

  it('identifies an invalid index and a missing template at the index stage', async () => {
    for (const [index, reason] of [[{ schemaVersion: 1, records: [null] }, 'invalid_index'], [{ schemaVersion: 1, records: [] }, 'template_not_found']] as const) {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/commits/') ? { sha: 'd'.repeat(40) } : index)));
      await expect(loadPublicTemplate('aeroframe', '1.0.1')).rejects.toMatchObject({ diagnostic: { stage: 'registry_index', reason } });
    }
  });

  it('identifies a checksum mismatch at the manifest stage', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/commits/')) return Response.json({ sha: 'd'.repeat(40) });
      if (url.endsWith('/index.json')) return Response.json({ schemaVersion: 1, records: [record] });
      return Response.json({ schemaVersion: 1 });
    }));
    await expect(loadPublicTemplate('aeroframe', '1.0.1')).rejects.toMatchObject({ diagnostic: { stage: 'manifest', reason: 'checksum_mismatch' } });
  });

  it('resolves the registry branch to a commit and verifies the manifest from the fixed source', async () => {
    const manifest = { schemaVersion: 1, id: 'aeroframe', version: '1.0.1', compatibility: { cmsSchema: 1, releaseSchema: 1 }, models: [], pages: [], presentation: {} };
    const verifiedRecord = { ...record, manifestChecksum: `sha256:${createHash('sha256').update(canonicalJson(manifest)).digest('hex')}` };
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith('/commits/registry')) return Response.json({ sha: 'd'.repeat(40) });
      if (url.endsWith('/registry/index.json')) return Response.json({ schemaVersion: 1, records: [verifiedRecord] });
      if (url.endsWith('/template.json')) return Response.json(manifest);
      throw new Error('unexpected URL');
    }));
    await expect(loadPublicTemplate('aeroframe', '1.0.1')).resolves.toEqual(verifiedRecord);
    expect(calls).toEqual([
      'https://api.github.com/repos/tangtianshuo/Independent-Website-Templates/commits/registry',
      `https://raw.githubusercontent.com/tangtianshuo/Independent-Website-Templates/${'d'.repeat(40)}/registry/index.json`,
      `https://raw.githubusercontent.com/tangtianshuo/Independent-Website-Templates/${'c'.repeat(40)}/templates/aeroframe/1.0.1/template.json`,
    ]);
  });

  it.each([
    ['id', { id: 'market' }],
    ['version', { version: '1.0.2' }],
    ['schema', { schemaVersion: 2 }],
    ['CMS compatibility', { compatibility: { cmsSchema: 2, releaseSchema: 1 } }],
    ['release compatibility', { compatibility: { cmsSchema: 1, releaseSchema: 2 } }],
    ['models', { models: null }],
    ['pages', { pages: {} }],
    ['presentation', { presentation: null }],
  ])('rejects a checksum-correct manifest with invalid %s', async (_label, changed) => {
    const manifest = { schemaVersion: 1, id: 'aeroframe', version: '1.0.1', compatibility: { cmsSchema: 1, releaseSchema: 1 }, models: [], pages: [], presentation: {}, ...changed };
    const verifiedRecord = { ...record, manifestChecksum: `sha256:${createHash('sha256').update(canonicalJson(manifest)).digest('hex')}` };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/commits/registry')) return Response.json({ sha: 'd'.repeat(40) });
      if (url.endsWith('/registry/index.json')) return Response.json({ schemaVersion: 1, records: [verifiedRecord] });
      return Response.json(manifest);
    }));
    await expect(loadPublicTemplate('aeroframe', '1.0.1')).rejects.toThrow(/manifest/i);
  });
});
