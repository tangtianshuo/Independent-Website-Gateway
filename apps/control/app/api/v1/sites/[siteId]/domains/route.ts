import { reserveDomain } from '@/src/domains';

export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: Promise<{ siteId: string }> }): Promise<Response> {
  const { siteId } = await params;
  return reserveDomain(request, siteId);
}
