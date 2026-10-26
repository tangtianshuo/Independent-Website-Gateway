import type { Pool } from 'pg';
import { authenticateService } from './auth';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function readSiteInfo(request: Request, siteId: string, pool: Pool): Promise<Response> {
  let principal;
  try {
    principal = authenticateService(request.headers.get('authorization') ?? undefined, {
      secret: process.env.CMS_SERVICE_SECRET ?? '',
      workspaceId: process.env.CMS_WORKSPACE_ID ?? '',
    });
  } catch {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!uuid.test(siteId) || !uuid.test(principal.workspaceId)) return Response.json({ error: 'invalid_request' }, { status: 400 });

  try {
    const result = await pool.query<{ desiredRevision: number }>(
      'SELECT "desiredRevision" FROM "Site" WHERE "id" = $1 AND "workspaceId" = $2',
      [siteId, principal.workspaceId],
    );
    if (!result.rowCount) return Response.json({ error: 'site_not_found' }, { status: 404 });
    return Response.json({ revision: result.rows[0].desiredRevision }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ error: 'site_unavailable' }, { status: 503 });
  }
}
