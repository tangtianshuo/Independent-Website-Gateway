import { Pool } from 'pg';
import { authenticateCmsService } from '../../../../src/auth';
import { provisionSite, ProvisionError, type ProvisionInput } from '../../../../src/provisioning';
import { serviceScopeErrorResponse } from '../../../../src/service-scope';

export const runtime = 'nodejs';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export async function POST(request: Request): Promise<Response> {
  let instanceId: string;
  try { ({ instanceId } = authenticateCmsService(request.headers.get('authorization') ?? undefined)); }
  catch (error) { return serviceScopeErrorResponse(error); }
  let input: unknown;
  try { input = await request.json(); }
  catch { return Response.json({ error: 'invalid_request' }, { status: 400 }); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return Response.json({ error: 'invalid_request' }, { status: 400 });
  try {
    return Response.json(await provisionSite(pool, instanceId, input as ProvisionInput, process.env.PLATFORM_DOMAIN ?? ''), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof ProvisionError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: 'provisioning_unavailable' }, { status: 503 });
  }
}
