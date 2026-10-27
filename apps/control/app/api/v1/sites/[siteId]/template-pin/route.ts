import { updateTemplatePin } from '@/src/template-pin';
export const runtime = 'nodejs';
export async function PUT(request: Request, { params }: { params: Promise<{ siteId: string }> }): Promise<Response> {
  return updateTemplatePin(request, (await params).siteId);
}
