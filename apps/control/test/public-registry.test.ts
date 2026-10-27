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
