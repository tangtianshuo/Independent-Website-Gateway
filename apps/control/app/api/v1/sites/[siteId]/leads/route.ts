import { Pool } from 'pg';
import { timingSafeEqual } from 'node:crypto';

export const runtime = 'nodejs';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function internalAuthorized(request: Request): boolean {
  const expected = process.env.CMS_SERVICE_SECRET || '';
  const value = request.headers.get('authorization') || '';
  if (!expected || !value.startsWith('Bearer ')) return false;
  const provided = Buffer.from(value.slice(7));
  const secret = Buffer.from(expected);
  return provided.length === secret.length && timingSafeEqual(provided, secret);
}

function internalResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ siteId: string }> },
): Promise<Response> {
  const { siteId } = await params;
  if (!internalAuthorized(request)) return internalResponse({ error: 'unauthorized' }, 401);
  if (!uuid.test(siteId)) return internalResponse({ error: 'invalid_request' }, 400);
  const query = new URL(request.url).searchParams;
  const status = query.get('status');
  const search = query.get('search')?.trim();
  const limit = Math.min(Math.max(Number(query.get('limit') || 50), 1), 200);
  const skip = Math.max(Number(query.get('skip') || 0), 0);
  if (status && !['new', 'contacted', 'qualified', 'closed', 'spam'].includes(status))
    return internalResponse({ error: 'invalid_request' }, 400);
  const values: unknown[] = [siteId];
  const where = ['lead."siteId" = $1'];
  if (status) {
    values.push(status);
    where.push(`lead."status" = $${values.length}`);
  }
  if (search) {
    values.push(`%${search.slice(0, 120)}%`);
    where.push(
      `(lead."name" ILIKE $${values.length} OR lead."email" ILIKE $${values.length} OR lead."message" ILIKE $${values.length})`,
    );
  }
  values.push(limit, skip);
  const result = await pool.query(
    `SELECT lead.* FROM "Lead" lead WHERE ${where.join(' AND ')} ORDER BY lead."createdAt" DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return internalResponse({ items: result.rows });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ siteId: string }> },
): Promise<Response> {
  const { siteId } = await params;
  if (!internalAuthorized(request)) return internalResponse({ error: 'unauthorized' }, 401);
  if (!uuid.test(siteId)) return internalResponse({ error: 'invalid_request' }, 400);
  const id = new URL(request.url).searchParams.get('id');
  if (!id || !uuid.test(id)) return internalResponse({ error: 'invalid_request' }, 400);
  const body = (await request.json()) as Record<string, unknown>;
  const status = body.status === undefined ? undefined : String(body.status);
  const assignedTo = body.assignedTo === undefined ? undefined : String(body.assignedTo).trim();
  const notes = body.notes === undefined ? undefined : String(body.notes);
  if (status !== undefined && !['new', 'contacted', 'qualified', 'closed', 'spam'].includes(status))
    return internalResponse({ error: 'invalid_request' }, 400);
  if (
    (assignedTo !== undefined && assignedTo.length > 120) ||
    (notes !== undefined && notes.length > 2000)
  )
    return internalResponse({ error: 'invalid_request' }, 400);
  const fields: string[] = [];
  const values: unknown[] = [];
  if (status !== undefined) {
    values.push(status);
    fields.push(`"status" = $${values.length}`);
  }
  if (assignedTo !== undefined) {
    values.push(assignedTo || null);
    fields.push(`"assignedTo" = $${values.length}`);
  }
  if (notes !== undefined) {
    values.push(notes);
    fields.push(`"notes" = $${values.length}`);
  }
  if (!fields.length) return internalResponse({ error: 'invalid_request' }, 400);
  values.push(id, siteId);
  const result = await pool.query(
    `UPDATE "Lead" SET ${fields.join(', ')}, "updatedAt" = now() WHERE "id" = $${values.length - 1} AND "siteId" = $${values.length} RETURNING *`,
    values,
  );
  if (!result.rowCount) return internalResponse({ error: 'lead_not_found' }, 404);
  return internalResponse({ item: result.rows[0] });
}
