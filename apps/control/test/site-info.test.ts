import { describe, expect, it, vi } from 'vitest';
import { readSiteInfo } from '../src/site-info';

const siteId = '123e4567-e89b-42d3-a456-426614174000';

function request(authorization?: string) {
  return new Request(`http://localhost/api/v1/sites/${siteId}`, {
    headers: authorization ? { authorization } : undefined,
  });
}

describe('site info', () => {
  it('requires CMS service authentication and returns the desired revision', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ desiredRevision: 7 }], rowCount: 1 });
    const pool = { query } as never;

    expect((await readSiteInfo(request(), siteId, pool)).status).toBe(401);
    process.env.CMS_SERVICE_SECRET = 'site-info-secret';
    process.env.CMS_WORKSPACE_ID = '123e4567-e89b-42d3-a456-426614174001';
    const response = await readSiteInfo(request('Bearer site-info-secret'), siteId, pool);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revision: 7 });
    expect(query).toHaveBeenCalledOnce();
  });

  it('does not reveal a site outside the authenticated workspace', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    process.env.CMS_SERVICE_SECRET = 'site-info-secret';
    process.env.CMS_WORKSPACE_ID = '123e4567-e89b-42d3-a456-426614174001';

    expect((await readSiteInfo(request('Bearer site-info-secret'), siteId, { query } as never)).status).toBe(404);
  });
});
