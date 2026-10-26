import { describe, expect, it } from 'vitest';
import { normalizeHostname } from '../src/domains';

describe('hostname normalization', () => {
  it('folds case and removes one trailing dot', () => {
    expect(normalizeHostname('WWW.Example.COM.')).toBe('www.example.com');
  });

  it('converts IDN labels to ASCII', () => {
    expect(normalizeHostname('BÜCHER.Example.')).toBe('xn--bcher-kva.example');
  });

  it.each(['127.0.0.1', '[::1]', '::1', '*.example.com', 'example..com', 'localhost', '-bad.example', 'bad-.example', 'bad_name.example', 'https://example.com', 'example.com:443', ' example.com', 'example.com..', 'a'.repeat(64) + '.example', 'a'.repeat(250) + '.com'])('rejects invalid hostname %s', hostname => {
    expect(() => normalizeHostname(hostname)).toThrow('Invalid hostname');
  });
});
