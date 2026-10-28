import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPublicationState } from '../src/publication-state';

const siteId = '123e4567-e89b-42d3-a456-426614174000';
const workspaceId = '123e4567-e89b-42d3-a456-426614174001';
const foreignId = '123e4567-e89b-42d3-a456-426614174002';
const imageDigest = `sha256:${'a'.repeat(64)}`;
const metadata = { templateId: 'aeroframe', templateVersion: '1.0.3', manifestChecksum: `sha256:${'b'.repeat(64)}`, imageDigest,
  imageRepository: 'example.com/aeroframe', sourceCommit: 'c'.repeat(40) };
const snapshot = { schemaVersion: 1, workspaceId, siteId, pages: [{ path: '/', title: 'Live' }] };
const checksum = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const request = (token: string | null = 'publication-secret') => new Request(`http://localhost/api/v1/sites/${siteId}/publication-state`, {
  headers: token === null ? undefined : { authorization: `Bearer ${token}` },
});

describe('publication state', () => {
  let directory: string;
  let path: string;
  let row: Record<string, unknown>;
  beforeEach(async () => {
    vi.stubEnv('CMS_SERVICE_SECRET', 'publication-secret');
    vi.stubEnv('CMS_WORKSPACE_ID', workspaceId);
    directory = await mkdtemp(join(tmpdir(), 'publication-state-'));
    path = join(directory, 'immutable.snapshot');
    await writeFile(path, JSON.stringify(snapshot));
    row = { desiredRevision: 9, releaseId: 'live-release', imageDigest, routeRevision: 7,
      metadata: { ...metadata, checksum: 'internal-hash', credentialHash: 'private-hash', snapshotRef: path },
      checksum: checksum(JSON.stringify(snapshot)), snapshotRef: path, createdAt: new Date('2026-10-27T10:00:00Z') };
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  function pool(owned = true) {
    return { query: vi.fn(async (sql: string, values: unknown[]) => {
      // The database is external; retain its ownership predicate in this boundary double.
      if (!/WHERE site\."id" = \$1 AND site\."workspaceId" = \$2/.test(sql)) throw new Error('Missing ownership scope');
      return owned && values[0] === siteId && values[1] === workspaceId ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }) } as never;
  }
  it('rejects missing and wrong service credentials before querying', async () => {
    const unavailable = { query: () => { throw new Error('Must not query'); } } as never;
    for (const token of [null, 'wrong']) {
      const response = await readPublicationState(request(token), siteId, unavailable);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });
  it('does not reveal a foreign workspace site', async () => {
    const response = await readPublicationState(request(), siteId, pool(false));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'site_not_found' });
  });
  it('returns the desired revision with no active release', async () => {
    row = { desiredRevision: 9, releaseId: null, imageDigest: null, routeRevision: null, metadata: null, checksum: null, snapshotRef: null, createdAt: null };
    const response = await readPublicationState(request(), siteId, pool());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revision: 9, active: null });
  });
  it('returns the authoritative active tuple and immutable snapshot without private storage fields', async () => {
    const response = await readPublicationState(request(), siteId, pool());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ revision: 9, active: {
      releaseId: 'live-release', imageDigest, routeRevision: 7, metadata, snapshot, createdAt: '2026-10-27T10:00:00.000Z',
    } });
  });
  it('verifies the checksum over original bytes instead of normalized JSON', async () => {
    await writeFile(path, JSON.stringify(snapshot, null, 2));
    const response = await readPublicationState(request(), siteId, pool());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'publication_state_unavailable' });
  });
  it.each([
    ['malformed JSON', '{'], ['wrong schema', { ...snapshot, schemaVersion: 2 }],
    ['wrong site', { ...snapshot, siteId: foreignId }], ['wrong workspace', { ...snapshot, workspaceId: foreignId }],
    ['array', []], ['null', null],
  ])('rejects a checksummed snapshot with %s', async (_name, value) => {
    const bytes = typeof value === 'string' ? value : JSON.stringify(value);
    await writeFile(path, bytes);
    row.checksum = checksum(bytes);
    const response = await readPublicationState(request(), siteId, pool());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'publication_state_unavailable' });
  });
  it('rejects invalid UTF-8 even when the replacement-decoded content would parse', async () => {
    const bytes = Buffer.concat([Buffer.from(JSON.stringify(snapshot).slice(0, -1) + ',\"title\":\"'), Buffer.from([0xff]), Buffer.from('\"}')]);
    await writeFile(path, bytes);
    row.checksum = checksum(bytes);
    expect((await readPublicationState(request(), siteId, pool())).status).toBe(503);
  });
  it('accepts a valid snapshot exactly at the existing 10MB limit', async () => {
    const bytes = Buffer.from(JSON.stringify(snapshot).padEnd(10 * 1024 * 1024, ' '));
    await writeFile(path, bytes);
    row.checksum = checksum(bytes);
    const response = await readPublicationState(request(), siteId, pool());
    expect(response.status).toBe(200);
    expect((await response.json()).active.snapshot).toEqual(snapshot);
  });
  it('rejects a snapshot larger than the existing 10MB limit', async () => {
    const bytes = Buffer.from(JSON.stringify(snapshot).padEnd(10 * 1024 * 1024 + 1, ' '));
    await writeFile(path, bytes);
    row.checksum = checksum(bytes);
    expect((await readPublicationState(request(), siteId, pool())).status).toBe(503);
  });
  it.each([
    { snapshotRef: null }, { checksum: 'invalid' }, { metadata: [] },
    { metadata: { ...metadata, imageDigest: `sha256:${'c'.repeat(64)}` } },
  ])('fails closed for an incomplete or inconsistent active release: %j', async (invalid) => {
    Object.assign(row, invalid);
    const response = await readPublicationState(request(), siteId, pool());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'publication_state_unavailable' });
  });
});
