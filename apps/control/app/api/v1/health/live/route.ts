import type { HealthResponse } from '@gateway/contracts';

export function GET(_request: Request) {
  const body: HealthResponse = { status: 'ok' };
  return Response.json(body);
}
