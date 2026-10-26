import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { canonicalJson } from '@gateway/contracts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const release = /^[a-zA-Z0-9._-]{1,128}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

export async function readPublishedRelease(request: Request, siteId: string, pool: Pool): Promise<Response> {
  const auth = request.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!uuid.test(siteId) || !token || token.length > 256) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const requestedRelease = new URL(request.url).searchParams.get('releaseId');
  if (requestedRelease !== null && !release.test(requestedRelease)) return Response.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const result = requestedRelease === null
      ? await pool.query<{ workspaceId: string; credentialHash: string | null; releaseId: string | null; checksum: string | null; snapshotRef: string | null }>(`
        SELECT site."workspaceId", site."credentialHash", active."releaseId", saved."checksum", saved."snapshotRef"
        FROM "Site" site LEFT JOIN "ActiveDeployment" active ON active."siteId" = site."id"
        LEFT JOIN "Release" saved ON saved."siteId" = site."id" AND saved."releaseId" = active."releaseId"
        WHERE site."id" = $1`, [siteId])
      : await pool.query<{ workspaceId: string; credentialHash: string | null; releaseId: string | null; checksum: string | null; snapshotRef: string | null }>(`
        SELECT site."workspaceId", operation."candidateCredentialHash" AS "credentialHash", saved."releaseId", saved."checksum", saved."snapshotRef"
        FROM "Site" site JOIN "PublishOperation" operation ON operation."siteId" = site."id"
          AND operation."workspaceId" = site."workspaceId" AND operation."releaseId" = $2
          AND operation."status" = 'pending' AND operation."leaseOwner" IS NOT NULL
          AND operation."leaseUntil" > clock_timestamp() AND operation."candidateCredentialHash" IS NOT NULL
        JOIN "Release" saved ON saved."siteId" = site."id" AND saved."releaseId" = operation."releaseId"
        WHERE site."id" = $1
        UNION ALL
        SELECT site."workspaceId", site."credentialHash", saved."releaseId", saved."checksum", saved."snapshotRef"
        FROM "Site" site JOIN "ActiveDeployment" active ON active."siteId" = site."id" AND active."releaseId" = $2
        JOIN "Release" saved ON saved."siteId" = site."id" AND saved."releaseId" = active."releaseId"
        WHERE site."id" = $1`, [siteId, requestedRelease]);
    const tokenHash = Buffer.from(sha256(token), 'hex');
    const row = result.rows.find(item => item.credentialHash && /^[a-f0-9]{64}$/.test(item.credentialHash)
      && timingSafeEqual(tokenHash, Buffer.from(item.credentialHash, 'hex')));
    if (!row) return Response.json({ error: 'unauthorized' }, { status: 401 });
    if (!row.releaseId || !row.snapshotRef) return Response.json({ error: 'release_not_found' }, { status: 404 });
    if (!row.checksum || !digest.test(row.checksum)) throw new Error('Invalid checksum');
    const bytes = await readFile(row.snapshotRef);
    if (bytes.length > 10 * 1024 * 1024 || `sha256:${sha256(bytes)}` !== row.checksum) throw new Error('Invalid snapshot bytes');
    const snapshot: unknown = JSON.parse(bytes.toString('utf8'));
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('Invalid snapshot');
    const object = snapshot as Record<string, unknown>;
    if (object.schemaVersion !== 1 || object.siteId !== siteId || object.workspaceId !== row.workspaceId) throw new Error('Invalid snapshot identity');
    return Response.json({ schemaVersion: 1, workspaceId: row.workspaceId, siteId, releaseId: row.releaseId,
      checksum: sha256(canonicalJson(snapshot)), snapshot }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ error: 'release_unavailable' }, { status: 503 });
  }
}
