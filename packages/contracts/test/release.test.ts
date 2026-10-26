import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, validateReleaseInput } from '../src/release.ts';

const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

describe('release contracts', () => {
  it('canonicalizes object keys recursively before hashing', () => {
    expect(canonicalJson({ z: 1, a: { y: true, b: 'x' } })).toBe('{"a":{"b":"x","y":true},"z":1}');
  });

  it('accepts only bounded identity and allowlisted immutable image digest', () => {
    const input = {
      siteId: 'site-1',
      releaseId: 'release-1',
      checksum: hash(Buffer.from('snapshot')),
      metadata: { templateId: 'storefront', templateVersion: '1.2.0', manifestChecksum: hash('manifest'), imageDigest: hash('image') },
      snapshot: Buffer.from('snapshot').toString('base64'),
    };
    expect(validateReleaseInput(input, ['storefront'])).toEqual({ ...input, imageDigest: hash('image') });
    expect(() => validateReleaseInput({ ...input, metadata: { ...input.metadata, imageDigest: 'storefront:latest' } }, ['storefront'])).toThrow();
    expect(() => validateReleaseInput(input, ['other-template'])).toThrow();
    expect(() => validateReleaseInput({ ...input, checksum: hash('different') }, ['storefront'])).toThrow();
  });
});
