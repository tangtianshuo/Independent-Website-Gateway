import { Pool } from 'pg';
import { authenticateSiteService, serviceScopeErrorResponse } from '../../../../../../src/service-scope';

export const runtime = 'nodejs';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

export async function GET(request: Request, { params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  let principal;
  try { principal = await authenticateSiteService(request, siteId, pool); }
  catch (error) { return serviceScopeErrorResponse(error); }
  if (!uuid.test(siteId)) return json({ error: 'invalid_request' }, 400);
  const query = new URL(request.url).searchParams;
  const days = Math.min(Math.max(Number(query.get('days') || 7), 1), 90);
  const result = await pool.query(
    `SELECT COUNT(*)::int AS views, COUNT(DISTINCT "visitorHash")::int AS visitors, "path" FROM "AnalyticsEvent" WHERE "siteId" = $1 AND "workspaceId" = $3 AND "eventType" = 'page_view' AND "createdAt" >= now() - ($2::int * interval '1 day') GROUP BY "path" ORDER BY views DESC, "path" ASC LIMIT 100`,
    [siteId, days, principal.workspaceId],
  );
  const total = await pool.query(
    `SELECT COUNT(*)::int AS views, COUNT(DISTINCT "visitorHash")::int AS visitors FROM "AnalyticsEvent" WHERE "siteId" = $1 AND "workspaceId" = $3 AND "eventType" = 'page_view' AND "createdAt" >= now() - ($2::int * interval '1 day')`,
    [siteId, days, principal.workspaceId],
  );
  return json({ days, totals: total.rows[0] || { views: 0, visitors: 0 }, pages: result.rows });
}
