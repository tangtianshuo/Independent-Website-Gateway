import { Pool } from 'pg';
import { readPublishOperation } from '@/src/publish-operation';
export const runtime = 'nodejs';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export async function GET(request: Request, { params }: { params: Promise<{ siteId: string; operationId: string }> }): Promise<Response> {
  const { siteId, operationId } = await params;
  return readPublishOperation(request, siteId, operationId, pool);
}
