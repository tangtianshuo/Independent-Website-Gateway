import { checkReservedDomain, mutateDomain } from '@/src/domains';
export const runtime = 'nodejs';
export async function POST(request: Request, { params }: {params: Promise<{siteId:string;domainId:string;operation:string}>}): Promise<Response> {
  const {siteId,domainId,operation}=await params;
  if (operation==='check') return checkReservedDomain(request,siteId,domainId);
  if (operation==='primary' || operation==='state' || operation==='remove') return mutateDomain(request,siteId,domainId,operation);
  return Response.json({error:'invalid_request'},{status:400});
}
