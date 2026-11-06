import { Pool } from 'pg';
import { timingSafeEqual } from 'node:crypto';

export const runtime = 'nodejs';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
function internalAuthorized(request: Request) {
  const expected = process.env.CMS_SERVICE_SECRET || '';
  const value = request.headers.get('authorization') || '';
  if (!expected || !value.startsWith('Bearer ')) return false;
  const a = Buffer.from(value.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request, { params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  if (!internalAuthorized(request)) return json({ error: 'unauthorized' }, 401);
  if (!uuid.test(siteId)) return json({ error: 'invalid_request' }, 400);
  const query = new URL(request.url).searchParams;
  const days = Math.min(Math.max(Number(query.get('days') || 7), 1), 90);
  const result = await pool.query(
    `SELECT COUNT(*)::int AS views, COUNT(DISTINCT "visitorHash")::int AS visitors, "path" FROM "AnalyticsEvent" WHERE "siteId" = $1 AND "eventType" = 'page_view' AND "createdAt" >= now() - ($2::int * interval '1 day') GROUP BY "path" ORDER BY views DESC, "path" ASC LIMIT 100`,
    [siteId, days],
  );
  const total = await pool.query(
    `SELECT COUNT(*)::int AS views, COUNT(DISTINCT "visitorHash")::int AS visitors FROM "AnalyticsEvent" WHERE "siteId" = $1 AND "eventType" = 'page_view' AND "createdAt" >= now() - ($2::int * interval '1 day')`,
    [siteId, days],
  );
  return json({ days, totals: total.rows[0] || { views: 0, visitors: 0 }, pages: result.rows });
}
