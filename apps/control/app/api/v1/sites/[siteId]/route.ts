import { Pool } from 'pg';
import { readSiteInfo } from '@/src/site-info';

export const runtime = 'nodejs';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function GET(request: Request, { params }: { params: Promise<{ siteId: string }> }): Promise<Response> {
  const { siteId } = await params;
  return readSiteInfo(request, siteId, pool);
}
