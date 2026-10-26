import { createPublishOperation } from '@/src/publish';

export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: Promise<{ siteId: string }> }): Promise<Response> {
  const { siteId } = await params;
  return createPublishOperation(request, siteId);
}
