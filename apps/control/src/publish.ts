import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { authenticateSiteService, serviceScopeErrorResponse } from './service-scope';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createPublishOperation(request: Request, siteId: string, database: Pool = pool): Promise<Response> {
  let principal;
  try {
    principal = await authenticateSiteService(request, siteId, database);
  } catch (error) {
    return serviceScopeErrorResponse(error);
  }
  if (!uuid.test(siteId) || !uuid.test(principal.workspaceId)) return Response.json({ error: 'invalid_request' }, { status: 400 });
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return Response.json({ error: 'invalid_request' }, { status: 400 });
  const { releaseId, idempotencyKey, expectedRevision } = input as Record<string, unknown>;
  if (typeof releaseId !== 'string' || !releaseId.length || releaseId.length > 256 ||
      typeof idempotencyKey !== 'string' || !idempotencyKey.length || idempotencyKey.length > 256 ||
      !Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0 || (expectedRevision as number) > 2147483646) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }

  let client;
  try {
    client = await database.connect();
    await client.query('BEGIN');
    const site = await client.query('SELECT "desiredRevision" FROM "Site" WHERE "id" = $1 AND "workspaceId" = $2 FOR UPDATE', [siteId, principal.workspaceId]);
    if (!site.rowCount) return Response.json({ error: 'site_not_found' }, { status: 404 });
    if ((await client.query(`SELECT 1 FROM "DomainChange" WHERE "siteId"=$1 AND "status"='pending'`, [siteId])).rowCount) return Response.json({ error: 'domain_change_pending' }, { status: 409 });
    const existing = await client.query('SELECT "id", "releaseId", "expectedRevision", "desiredRevision", "status" FROM "PublishOperation" WHERE "siteId" = $1 AND "idempotencyKey" = $2', [siteId, idempotencyKey]);
    if (existing.rowCount) {
      const operation = existing.rows[0];
      if (operation.releaseId !== releaseId || operation.expectedRevision !== expectedRevision) return Response.json({ error: 'idempotency_conflict' }, { status: 409 });
      return Response.json(operation, { status: 200 });
    }
    if (site.rows[0].desiredRevision !== expectedRevision) return Response.json({ error: 'revision_conflict' }, { status: 409 });
    const release = await client.query('SELECT "id" FROM "Release" WHERE "siteId" = $1 AND "releaseId" = $2', [siteId, releaseId]);
    if (!release.rowCount) return Response.json({ error: 'release_not_found' }, { status: 404 });
    const id = randomUUID();
    const desiredRevision = (expectedRevision as number) + 1;
    const created = await client.query('INSERT INTO "PublishOperation" ("id", "workspaceId", "siteId", "idempotencyKey", "releaseId", "expectedRevision", "desiredRevision", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING "id", "releaseId", "expectedRevision", "desiredRevision", "status"', [id, principal.workspaceId, siteId, idempotencyKey, releaseId, expectedRevision, desiredRevision]);
    await client.query('UPDATE "Site" SET "desiredRevision" = $1, "desiredReleaseId" = $2, "updatedAt" = now() WHERE "id" = $3', [desiredRevision, releaseId, siteId]);
    await client.query(`INSERT INTO "Publication"
      ("siteId", "desiredReleaseId", "desiredRevision", "status", "updatedAt")
      VALUES ($1, $2, $3, 'pending', now())
      ON CONFLICT ("siteId") DO UPDATE SET "desiredReleaseId" = EXCLUDED."desiredReleaseId",
        "desiredRevision" = EXCLUDED."desiredRevision", "status" = 'pending', "updatedAt" = now()`,
      [siteId, releaseId, desiredRevision]);
    await client.query('COMMIT');
    return Response.json(created.rows[0], { status: 201 });
  } catch {
    return Response.json({ error: 'publish_unavailable' }, { status: 503 });
  } finally {
    if (client) {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }
}
