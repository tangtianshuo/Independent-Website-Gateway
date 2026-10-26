import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { canonicalJson, validateReleaseInput } from '@gateway/contracts';
import { authenticateService } from './auth';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const maxRequestBytes = 14 * 1024 * 1024;

export async function receiveRelease(request: Request, routeSiteId: string): Promise<Response> {
  let client;
  let temporaryPath: string | undefined;
  let finalPath: string | undefined;
  let ownsFinalPath = false;
  let committed = false;
  try {
    const principal = authenticateService(request.headers.get('authorization') ?? undefined, {
      secret: process.env.CMS_SERVICE_SECRET ?? '',
      workspaceId: process.env.CMS_WORKSPACE_ID ?? '',
    });
    const contentLengthHeader = request.headers.get('content-length');
    const contentLength = contentLengthHeader === null ? 0 : Number(contentLengthHeader);
    if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > maxRequestBytes) return Response.json({ error: 'request_too_large' }, { status: 413 });
    if (!request.body) return Response.json({ error: 'invalid_release' }, { status: 400 });
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;
    const reader = request.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxRequestBytes) {
        await reader.cancel();
        return Response.json({ error: 'request_too_large' }, { status: 413 });
      }
      chunks.push(value);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    const input = validateReleaseInput(JSON.parse(raw), (process.env.ALLOWED_TEMPLATE_IDS ?? '').split(',').filter(Boolean));
    if (input.siteId !== routeSiteId) return Response.json({ error: 'site_not_found' }, { status: 404 });
    client = await pool.connect();
    await client.query('BEGIN');
    const site = await client.query('SELECT "id" FROM "Site" WHERE "id" = $1 AND "workspaceId" = $2 FOR UPDATE', [input.siteId, principal.workspaceId]);
    if (!site.rowCount) {
      await client.query('ROLLBACK');
      return Response.json({ error: 'site_not_found' }, { status: 404 });
    }

    const metadata = {
      ...input.metadata,
      checksum: createHash('sha256').update(JSON.stringify(input.metadata)).digest('hex'),
    };
    const existing = await client.query('SELECT "checksum", "metadata" FROM "Release" WHERE "siteId" = $1 AND "releaseId" = $2', [input.siteId, input.releaseId]);
    if (existing.rowCount) {
      if (existing.rows[0].checksum !== input.checksum || canonicalJson(existing.rows[0].metadata) !== canonicalJson(metadata)) {
        await client.query('ROLLBACK');
        return Response.json({ error: 'release_conflict' }, { status: 409 });
      }
      await client.query('COMMIT');
      committed = true;
      return Response.json({ siteId: input.siteId, releaseId: input.releaseId, checksum: input.checksum }, { status: 200 });
    }

    const bytes = Buffer.from(input.snapshot, 'base64');
    const directory = process.env.SNAPSHOT_STORAGE_PATH ?? '/var/lib/gateway/snapshots';
    await mkdir(directory, { recursive: true });
    const key = createHash('sha256').update(`${input.siteId}:${input.releaseId}`).digest('hex');
    finalPath = join(directory, `${key}.snapshot`);
    temporaryPath = join(directory, `${key}.${randomUUID()}.tmp`);
    await writeFile(temporaryPath, bytes, { flag: 'wx', mode: 0o600 });
    await link(temporaryPath, finalPath);
    ownsFinalPath = true;
    await client.query('INSERT INTO "Release" ("id", "siteId", "releaseId", "checksum", "metadata", "snapshotRef") VALUES ($1, $2, $3, $4, $5::jsonb, $6)', [randomUUID(), input.siteId, input.releaseId, input.checksum, JSON.stringify(metadata), finalPath]);
    await client.query('COMMIT');
    committed = true;
    return Response.json({ siteId: input.siteId, releaseId: input.releaseId, checksum: input.checksum }, { status: 201 });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof Error && error.message === 'Unauthorized') return Response.json({ error: 'unauthorized' }, { status: 401 });
    if (error instanceof SyntaxError || error instanceof Error && /Invalid|Template|checksum/.test(error.message)) return Response.json({ error: 'invalid_release' }, { status: 400 });
    if (ownsFinalPath && !committed) await rm(finalPath!, { force: true }).catch(() => undefined);
    return Response.json({ error: 'release_unavailable' }, { status: 503 });
  } finally {
    if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined);
    client?.release();
  }
}
