import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Pool } from 'pg';
import { authenticateService } from './auth';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^sha256:[a-f0-9]{64}$/;
const maxSnapshotBytes = 10 * 1024 * 1024;
const publicMetadataKeys = ['templateId', 'templateVersion', 'manifestChecksum', 'imageDigest', 'imageRepository', 'sourceCommit'] as const;

interface PublicationRow {
  desiredRevision: number;
  releaseId: string | null;
  imageDigest: string | null;
  routeRevision: number | null;
  metadata: unknown;
  checksum: string | null;
  snapshotRef: string | null;
  createdAt: Date | null;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readSnapshot(path: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  // Read at most one byte beyond the limit, even if a file grows after it was opened.
  for await (const chunk of createReadStream(path, { end: maxSnapshotBytes })) {
    const bytes = chunk as Buffer;
    length += bytes.length;
    if (length > maxSnapshotBytes) throw new Error('Invalid snapshot size');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export async function readPublicationState(request: Request, siteId: string, pool: Pool): Promise<Response> {
  let principal;
  try {
    principal = authenticateService(request.headers.get('authorization') ?? undefined, {
      secret: process.env.CMS_SERVICE_SECRET ?? '',
      workspaceId: process.env.CMS_WORKSPACE_ID ?? '',
    });
  } catch {
    return json({ error: 'unauthorized' }, 401);
  }
  if (!uuid.test(siteId) || !uuid.test(principal.workspaceId)) return json({ error: 'invalid_request' }, 400);

  try {
    // One statement reads a consistent desired revision and authoritative active tuple.
    const result = await pool.query<PublicationRow>(`
      SELECT site."desiredRevision", active."releaseId", active."imageDigest", active."routeRevision",
        saved."metadata", saved."checksum", saved."snapshotRef", saved."createdAt"
      FROM "Site" site
      LEFT JOIN "ActiveDeployment" active ON active."siteId" = site."id"
      LEFT JOIN "Release" saved ON saved."siteId" = site."id" AND saved."releaseId" = active."releaseId"
      WHERE site."id" = $1 AND site."workspaceId" = $2`, [siteId, principal.workspaceId]);
    if (!result.rowCount) return json({ error: 'site_not_found' }, 404);
    const row = result.rows[0];
    if (!Number.isSafeInteger(row.desiredRevision) || row.desiredRevision < 0) throw new Error('Invalid revision');
    if (row.releaseId === null) return json({ revision: row.desiredRevision, active: null });
    if (!row.releaseId || !row.imageDigest || !digest.test(row.imageDigest) ||
        !Number.isSafeInteger(row.routeRevision) || row.routeRevision! < 0 ||
        !row.snapshotRef || !row.checksum || !digest.test(row.checksum) ||
        !object(row.metadata) || !row.createdAt || !Number.isFinite(row.createdAt.getTime())) throw new Error('Invalid active release');
    if (row.metadata.imageDigest !== undefined && row.metadata.imageDigest !== null && row.metadata.imageDigest !== '' &&
        row.metadata.imageDigest !== row.imageDigest) throw new Error('Inconsistent image pin');
    const bytes = await readSnapshot(row.snapshotRef);
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== row.checksum) throw new Error('Invalid snapshot checksum');
    const snapshot: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!object(snapshot) || snapshot.schemaVersion !== 1 || snapshot.workspaceId !== principal.workspaceId ||
        snapshot.siteId !== siteId) throw new Error('Invalid snapshot identity');
    const storedMetadata = row.metadata;
    const metadata = Object.fromEntries(publicMetadataKeys.flatMap(key =>
      typeof storedMetadata[key] === 'string' ? [[key, storedMetadata[key]]] : []));
    return json({ revision: row.desiredRevision, active: {
      releaseId: row.releaseId, imageDigest: row.imageDigest, routeRevision: row.routeRevision,
      metadata, snapshot, createdAt: row.createdAt.toISOString(),
    } });
  } catch {
    return json({ error: 'publication_state_unavailable' }, 503);
  }
}
