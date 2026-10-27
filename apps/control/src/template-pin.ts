import { Pool } from 'pg';
import { authenticateService } from './auth';
import { loadPublicTemplate } from './public-registry';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function updateTemplatePin(request: Request, siteId: string): Promise<Response> {
  let principal;
  try { principal = authenticateService(request.headers.get('authorization') ?? undefined, { secret: process.env.CMS_SERVICE_SECRET ?? '', workspaceId: process.env.CMS_WORKSPACE_ID ?? '' }); }
  catch { return Response.json({ error: 'unauthorized' }, { status: 401 }); }
  if (!uuid.test(siteId) || !uuid.test(principal.workspaceId)) return Response.json({ error: 'invalid_request' }, { status: 400 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: 'invalid_request' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof (body as Record<string, unknown>).templateId !== 'string' || typeof (body as Record<string, unknown>).templateVersion !== 'string') return Response.json({ error: 'invalid_request' }, { status: 400 });
  let record;
  try { record = await loadPublicTemplate((body as { templateId: string }).templateId, (body as { templateVersion: string }).templateVersion); }
  catch (error) { return Response.json({ error: error instanceof Error && error.message === 'Public template not found' ? 'template_not_found' : 'invalid_template' }, { status: 400 }); }
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const site = await client.query('SELECT "id" FROM "Site" WHERE "id" = $1 AND "workspaceId" = $2 FOR UPDATE', [siteId, principal.workspaceId]);
    if (!site.rowCount) { await client.query('ROLLBACK'); return Response.json({ error: 'site_not_found' }, { status: 404 }); }
    const current = await client.query(`SELECT "version", "imageDigest", "imageRepository", "manifestChecksum", "sourceCommit"
      FROM "TemplatePin" WHERE "siteId" = $1 AND "templateId" = $2 FOR UPDATE`, [siteId, record.id]);
    const samePin = current.rowCount && current.rows[0].version === record.version && current.rows[0].imageDigest === record.imageDigest &&
      current.rows[0].imageRepository === record.imageRepository && current.rows[0].manifestChecksum === record.manifestChecksum &&
      current.rows[0].sourceCommit === record.sourceCommit;
    if (samePin) {
      await client.query('COMMIT');
      return Response.json({ ...record, templateId: record.id, templateVersion: record.version }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const pending = await client.query(`SELECT 1 FROM "PublishOperation" WHERE "siteId" = $1 AND "status" = 'pending' LIMIT 1`, [siteId]);
    if (pending.rowCount) { await client.query('ROLLBACK'); return Response.json({ error: 'publish_pending' }, { status: 409 }); }
    await client.query(`INSERT INTO "TemplatePin" ("id", "siteId", "templateId", "version", "imageDigest", "imageRepository", "manifestChecksum", "sourceCommit", "updatedAt")
      VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, now())
      ON CONFLICT ("siteId", "templateId") DO UPDATE SET "version" = EXCLUDED."version", "imageDigest" = EXCLUDED."imageDigest",
        "imageRepository" = EXCLUDED."imageRepository", "manifestChecksum" = EXCLUDED."manifestChecksum", "sourceCommit" = EXCLUDED."sourceCommit", "updatedAt" = now()`,
    [siteId, record.id, record.version, record.imageDigest, record.imageRepository, record.manifestChecksum, record.sourceCommit]);
    await client.query('COMMIT');
    return Response.json({ ...record, templateId: record.id, templateVersion: record.version }, { headers: { 'Cache-Control': 'no-store' } });
  } catch { await client?.query('ROLLBACK').catch(() => undefined); return Response.json({ error: 'template_pin_unavailable' }, { status: 503 }); }
  finally { client?.release(); }
}
