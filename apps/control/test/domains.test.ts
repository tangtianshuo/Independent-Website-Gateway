import { describe, expect, it } from 'vitest';
import { normalizeHostname, readDomainState } from '../src/domains';

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

describe('domain state projection', () => {
  it('returns Gateway-owned domain, certificate, publication, and route state', async () => {
    process.env.CMS_SERVICE_SECRET = 'test-secret';
    process.env.CMS_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
    const query = async (sql: string, values: unknown[]) => {
      expect(values).toEqual(['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001']);
      expect(sql).toContain('FROM "Site" site');
      expect(sql).toContain('LEFT JOIN "Publication" publication');
      expect(sql).toContain('LEFT JOIN "Deployment" deployment');
      return {
        rowCount: 2,
        rows: [
          {
            id: 'domain-primary', hostname: 'shop.example.com', ownershipStatus: 'verified', dnsStatus: 'ready',
            certificateStatus: 'ready', enabled: true, isPrimary: true, lastCheckedAt: '2026-11-02T08:00:00.000Z',
            publicationStatus: 'active', activeReleaseId: 'release-2', routeRevision: 2, routeHost: 'shop.example.com',
            deploymentHealthStatus: 'healthy',
          },
          {
            id: 'domain-alias', hostname: 'www.example.com', ownershipStatus: 'verified', dnsStatus: 'ready',
            certificateStatus: 'ready', enabled: true, isPrimary: false, lastCheckedAt: null,
            publicationStatus: 'active', activeReleaseId: 'release-2', routeRevision: 2, routeHost: 'shop.example.com',
            deploymentHealthStatus: 'healthy',
          },
        ],
      };
    };
    const response = await readDomainState(new Request('http://localhost', { headers: { authorization: 'Bearer test-secret' } }),
      '00000000-0000-4000-8000-000000000002', { query } as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      route: { status: 'active', revision: 2, releaseId: 'release-2', host: 'shop.example.com', health: 'healthy' },
      domains: [
        { id: 'domain-primary', hostname: 'shop.example.com', ownershipStatus: 'verified', dnsStatus: 'ready', certificateStatus: 'ready', enabled: true, role: 'primary', lastCheckedAt: '2026-11-02T08:00:00.000Z', redirectTo: null },
        { id: 'domain-alias', hostname: 'www.example.com', ownershipStatus: 'verified', dnsStatus: 'ready', certificateStatus: 'ready', enabled: true, role: 'alias', lastCheckedAt: null, redirectTo: 'https://shop.example.com' },
      ],
    });
  });

  it('fails closed when the requested site is not in the authenticated workspace', async () => {
    process.env.CMS_SERVICE_SECRET = 'test-secret';
    process.env.CMS_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
    const response = await readDomainState(new Request('http://localhost', { headers: { authorization: 'Bearer test-secret' } }),
      '00000000-0000-4000-8000-000000000002', { query: async () => ({ rowCount: 0, rows: [] }) } as never);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'site_not_found' });
  });
});
