import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { readPublishOperation } from '../src/publish-operation';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const siteId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';

describe('publish operation status', () => {
  it('requires service auth and returns only an operation scoped to its site and workspace', async () => {
    process.env.CMS_SERVICE_SECRET = 'status-secret';
    process.env.CMS_WORKSPACE_ID = workspaceId;
    const query = vi.fn(async () => ({ rowCount: 1, rows: [{ id: operationId, status: 'pending', failureCode: null, releaseId: 'release-a', revision: 3 }] }));
    const pool = { query } as unknown as Pool;
    const unauthorized = await readPublishOperation(new Request('http://local'), siteId, operationId, pool);
    expect(unauthorized.status).toBe(401);
    const response = await readPublishOperation(new Request('http://local', { headers: { authorization: 'Bearer status-secret' } }), siteId, operationId, pool);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: operationId, status: 'pending', failureCode: null, releaseId: 'release-a', revision: 3 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('operation."siteId" = $2 AND operation."workspaceId" = $3'), [operationId, siteId, workspaceId]);
  });
});
