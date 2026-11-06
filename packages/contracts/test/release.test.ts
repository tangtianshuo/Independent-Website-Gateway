import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, validateContractSnapshotV1, validateReleaseInput } from '../src/release.ts';

const hash = (value: string | Buffer) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

describe('release contracts', () => {
  it('canonicalizes object keys recursively before hashing', () => {
    expect(canonicalJson({ z: 1, a: { y: true, b: 'x' } })).toBe('{"a":{"b":"x","y":true},"z":1}');
    expect(canonicalJson({ a: 1, B: 2 })).toBe('{"B":2,"a":1}');
    expect(canonicalJson({ '10': 'ten', '2': 'two', a: 1 })).toBe('{"2":"two","10":"ten","a":1}');
  });

  it('accepts only bounded identity and allowlisted immutable image digest', () => {
    const input = {
      siteId: 'site-1',
      releaseId: 'release-1',
      checksum: hash(Buffer.from('{"pages":[]}')),
      metadata: { templateId: 'storefront', templateVersion: '1.2.0', manifestChecksum: hash('manifest'), imageDigest: hash('image') },
      snapshot: Buffer.from('{"pages":[]}').toString('base64'),
    };
    expect(validateReleaseInput(input, ['storefront'])).toEqual({ ...input, imageDigest: hash('image') });
    expect(() => validateReleaseInput({ ...input, metadata: { ...input.metadata, imageDigest: 'storefront:latest' } }, ['storefront'])).toThrow();
    expect(() => validateReleaseInput(input, ['other-template'])).toThrow();
    expect(() => validateReleaseInput({ ...input, checksum: hash('different') }, ['storefront'])).toThrow();
    const mismatched = Buffer.from('{"pages":[{"content":{"preset":{"id":"storefront","version":"9.9.9"}}}]}');
    expect(() => validateReleaseInput({ ...input, snapshot: mismatched.toString('base64'), checksum: hash(mismatched) }, ['storefront'])).toThrow(/identity/);
  });

  it('accepts a ContractSnapshotV1 release and binds site/template identity to metadata', () => {
    const contract = {
      contractVersion: 1,
      schemaVersion: 1,
      workspaceId: 'workspace',
      siteId: 'site-1',
      language: 'en',
      template: { id: 'aeroframe', version: '1.0.3' },
      pages: [{ path: '/', pageKey: 'home', entryId: 'home-entry', content: { kind: 'preset-page', view: 'home', preset: { id: 'aeroframe', version: '1.0.3' }, sections: [], seo: { title: 'Home', description: '' } } }],
      navigation: [], redirects: [], assets: [],
    };
    const snapshot = Buffer.from(JSON.stringify(contract));
    const input = {
      siteId: 'site-1', releaseId: 'release-contract', checksum: hash(snapshot.toString()),
      metadata: { templateId: 'aeroframe', templateVersion: '1.0.3', manifestChecksum: hash('manifest'), imageDigest: hash('image') },
      snapshot: snapshot.toString('base64'),
    };
    expect(validateReleaseInput(input, ['aeroframe'])).toEqual({ ...input, imageDigest: hash('image') });
    expect(() => validateReleaseInput({ ...input, metadata: { ...input.metadata, templateVersion: '1.0.2' } }, ['aeroframe'])).toThrow(/identity/i);
    expect(() => validateReleaseInput({ ...input, siteId: 'other-site' }, ['aeroframe'])).toThrow(/site|identity/i);
  });
});

describe('contract snapshot v1', () => {
  const valid = {
    contractVersion: 1,
    schemaVersion: 1,
    workspaceId: 'workspace',
    siteId: 'site',
    language: 'en',
    template: { id: 'aeroframe', version: '1.0.3' },
    pages: [{ path: '/', pageKey: 'home', entryId: 'home-entry', content: { kind: 'preset-page', view: 'home', preset: { id: 'aeroframe', version: '1.0.3' }, sections: [], seo: { title: 'Home', description: '' } } }],
    navigation: [{ id: 'home', label: 'Home', href: '/', children: [], enabled: true }],
    redirects: [],
    operations: { seoTitle: 'Home', seoDescription: '', contactFormEnabled: false },
    assets: [],
  };

  it('accepts the versioned snapshot envelope and returns it unchanged', () => {
    expect(validateContractSnapshotV1(valid)).toEqual(valid);
  });

  it('rejects mixed template identities and unknown root fields', () => {
    expect(() => validateContractSnapshotV1({ ...valid, extra: true })).toThrow(/root|field|unknown/i);
    expect(() => validateContractSnapshotV1({ ...valid, pages: [...valid.pages, { ...valid.pages[0], path: '/about', content: { ...valid.pages[0].content, preset: { id: 'fireguard', version: '1.0.0' } } }] })).toThrow(/template|identity/i);
  });

  it('rejects duplicate or unsafe published asset paths', () => {
    const bytes = Buffer.from('image');
    const asset = { path: 'media/image/original.png', checksum: hash(bytes), mimeType: 'image/png', mediaId: 'image', contentBase64: bytes.toString('base64') };
    expect(validateContractSnapshotV1({ ...valid, assets: [asset] })).toMatchObject({ assets: [asset] });
    expect(() => validateContractSnapshotV1({ ...valid, assets: [asset, asset] })).toThrow(/asset/i);
    expect(() => validateContractSnapshotV1({ ...valid, assets: [{ ...asset, path: '../image.png' }] })).toThrow(/asset/i);
  });

  it('verifies embedded immutable asset bytes against their manifest checksum', () => {
    const bytes = Buffer.from('image-bytes');
    const asset = { path: 'media/image/original.png', checksum: hash(bytes), mimeType: 'image/png', contentBase64: bytes.toString('base64') };
    expect(validateContractSnapshotV1({ ...valid, assets: [asset] }).assets[0]).toMatchObject(asset);
    expect(() => validateContractSnapshotV1({ ...valid, assets: [{ ...asset, contentBase64: Buffer.from('tampered').toString('base64') }] })).toThrow(/checksum/i);
  });
});
