import type { Pool } from 'pg';
import { ingestLead } from './leads.js';
import { ingestEvent } from './events.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxBodyBytes = 64 * 1024;
export interface IngestOptions {
  localOrigins?: string[];
  clientIp?: (request: Request) => string | undefined;
}
class BodyTooLarge extends Error {}

function originUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.origin === value && !url.username && !url.password ? url : undefined;
  } catch {
    return undefined;
  }
}
function localOrigin(value: string): boolean {
  const url = originUrl(value);
  return (
    !!url && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  );
}
async function readJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > maxBodyBytes) throw new BodyTooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError('Missing JSON body');
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBodyBytes) {
        await reader.cancel();
        throw new BodyTooLarge();
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

export function createIngestHandler(
  pool: Pool,
  options: IngestOptions = {},
): (request: Request) => Promise<Response> {
  const localOrigins = new Set(
    options.localOrigins ??
      (process.env.INGEST_LOCAL_ORIGINS || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
  );
  if ([...localOrigins].some((value) => !localOrigin(value)))
    throw new Error('INGEST_LOCAL_ORIGINS must contain explicit loopback HTTP origins');
  return async (request) => {
    const respond = (body: unknown, status: number, origin?: string) =>
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ...(origin
            ? {
                'Access-Control-Allow-Origin': origin,
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'content-type, x-lead-idempotency-key',
                Vary: 'Origin',
              }
            : {}),
        },
      });
    const route = new URL(request.url).pathname.match(
      /^\/api\/v1\/sites\/([^/]+)\/(leads|events)$/,
    );
    if (!route) return respond({ error: 'not_found' }, 404);
    if (!['POST', 'OPTIONS'].includes(request.method))
      return respond({ error: 'method_not_allowed' }, 405);
    if (!uuid.test(route[1])) return respond({ error: 'invalid_request' }, 400);
    if (request.headers.has('authorization'))
      return respond({ error: 'management_credentials_not_allowed' }, 403);
    const origin = request.headers.get('origin') || '';
    const url = originUrl(origin);
    if (!url || (url.protocol !== 'https:' && !localOrigins.has(origin)))
      return respond({ error: 'origin_not_allowed' }, 403);
    try {
      const site = await pool.query<{ workspaceId: string; hostname: string | null }>(
        `SELECT site."workspaceId", domain."hostname" FROM "Site" site LEFT JOIN "Domain" domain ON domain."siteId"=site."id" AND domain."status"='active' AND domain."enabled"=true WHERE site."id"=$1`,
        [route[1]],
      );
      if (!site.rowCount) return respond({ error: 'site_not_found' }, 404);
      if (!localOrigins.has(origin) && !site.rows.some((row) => row.hostname === url.hostname))
        return respond({ error: 'origin_not_allowed' }, 403);
      if (request.method === 'OPTIONS') {
        const method = request.headers.get('access-control-request-method');
        const headers = (request.headers.get('access-control-request-headers') || '')
          .toLowerCase()
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
        if (
          (method && method !== 'POST') ||
          headers.some((header) => !['content-type', 'x-lead-idempotency-key'].includes(header))
        )
          return respond({ error: 'invalid_preflight' }, 403);
        return respond(null, 204, origin);
      }
      if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json')
        return respond({ error: 'json_required' }, 415, origin);
      const body = await readJson(request);
      if (!body || typeof body !== 'object' || Array.isArray(body))
        return respond({ error: 'invalid_payload' }, 400, origin);
      // URL and database ownership always win over untrusted payload identities.
      const payload = { ...body, siteId: route[1] };
      const result =
        route[2] === 'leads'
          ? await ingestLead(
              pool,
              site.rows[0].workspaceId,
              {
                ...payload,
                ...(request.headers.get('x-lead-idempotency-key')
                  ? { idempotencyKey: request.headers.get('x-lead-idempotency-key') }
                  : {}),
              },
              { ip: options.clientIp?.(request) },
            )
          : await ingestEvent(pool, site.rows[0].workspaceId, payload);
      return respond({ accepted: true, ...result }, result.duplicate ? 200 : 202, origin);
    } catch (error) {
      if (error instanceof BodyTooLarge) return respond({ error: 'body_too_large' }, 413, origin);
      const message = error instanceof Error ? error.message : '';
      if (/rate limited/i.test(message))
        return respond({ error: 'rate_limited', retryable: true }, 429, origin);
      if (error instanceof SyntaxError || /invalid|rejected|unsupported|requires/i.test(message))
        return respond({ error: 'invalid_payload' }, 400, origin);
      return respond({ error: 'intake_unavailable', retryable: true }, 503, origin);
    }
  };
}
