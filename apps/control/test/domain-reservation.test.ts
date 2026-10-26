import { describe, expect, it } from 'vitest';
import { reserveDomain } from '../src/domains';

const siteId = '00000000-0000-4000-8000-000000000001';

function request(body: unknown, authorization = 'Bearer test-secret') {
  return new Request('http://localhost/api/v1/sites/' + siteId + '/domains', {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('domain reservation validation', () => {
  it('rejects unauthenticated requests before accessing the database', async () => {
    expect((await reserveDomain(request({ hostname: 'example.com' }, ''), siteId)).status).toBe(401);
  });

  it('rejects malformed and wildcard hostnames before accessing the database', async () => {
    process.env.CMS_SERVICE_SECRET = 'test-secret';
    process.env.CMS_WORKSPACE_ID = siteId;
    expect((await reserveDomain(request({ hostname: '*.example.com' }), siteId)).status).toBe(400);
    expect((await reserveDomain(request({ hostname: '127.0.0.1' }), siteId)).status).toBe(400);
    expect((await reserveDomain(request({ hostname: 'example.com' }), 'bad-site')).status).toBe(400);
  });
});
