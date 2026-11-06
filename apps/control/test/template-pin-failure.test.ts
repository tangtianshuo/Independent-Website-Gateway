import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { updateTemplatePin } from '../src/template-pin';

describe('template pin failure boundary', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  function request() {
    vi.stubEnv('CMS_SERVICE_SECRET', 'fixture-secret');
    vi.stubEnv('CMS_WORKSPACE_ID', '11111111-1111-4111-8111-111111111111');
    return new Request('http://localhost/template-pin', { method: 'PUT', headers: { authorization: 'Bearer fixture-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ templateId: 'aeroframe', templateVersion: '1.0.2' }) });
  }

  const ownedDatabase = {
    query: async (sql: string, values: unknown[]) => {
      if (sql !== 'SELECT "id" FROM "Site" WHERE "id" = $1 AND "workspaceId" = $2' || values[1] !== '11111111-1111-4111-8111-111111111111') throw new Error('Unexpected ownership query');
      return { rowCount: 1, rows: [{ id: values[0] }] };
    },
  } as unknown as Pool;

  it('returns a retryable service error for a registry outage and logs only structured diagnostics', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('https://private.invalid/?token=secret', { cause: { code: 'ECONNRESET' } }); }));
    const response = await updateTemplatePin(request(), randomUUID(), ownedDatabase);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'template_registry_unavailable' });
    expect(log).toHaveBeenCalledTimes(1);
    const diagnostic = JSON.parse(log.mock.calls[0][0]);
    expect(diagnostic).toMatchObject({ event: 'template_verification_failed', stage: 'registry_commit', reason: 'network', networkCode: 'ECONNRESET', elapsedMs: expect.any(Number) });
    expect(JSON.stringify(diagnostic)).not.toMatch(/private|token|secret|https:/);
  });

  it('retains invalid_template for malformed approved data and logs its validation stage', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sha: 'not-a-commit' })));
    const response = await updateTemplatePin(request(), randomUUID(), ownedDatabase);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_template' });
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ stage: 'registry_commit', reason: 'invalid_commit' });
  });
});
