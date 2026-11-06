import { randomUUID, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Removing any origin, ownership, size, dedupe or transport-IP check must fail these real DB assertions.
const run = process.env.GATEWAY_TEST_DATABASE_URL ? describe : describe.skip;
run('independent public intake HTTP', () => {
  const pool = new Pool({ connectionString: process.env.GATEWAY_TEST_DATABASE_URL });
  const workspaceId = randomUUID(),
    siteId = randomUUID(),
    otherSite = randomUUID();
  let handler: (request: Request) => Promise<Response>;
  function request(
    kind = 'leads',
    body: unknown = { source: 'contact', email: 'visitor@example.test', message: 'hello' },
    headers: Record<string, string> = {},
    site = siteId,
  ) {
    return new Request(`http://localhost/api/v1/sites/${site}/${kind}`, {
      method: 'POST',
      headers: { origin: 'https://owned.example', 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }
  beforeAll(async () => {
    const { createIngestHandler } = await import('./http');
    handler = createIngestHandler(pool);
    await pool.query('INSERT INTO "Workspace" ("id","name","updatedAt") VALUES ($1,$2,now())', [
      workspaceId,
      'intake test',
    ]);
    await pool.query(
      'INSERT INTO "Site" ("id","workspaceId","updatedAt") VALUES ($1,$3,now()),($2,$3,now())',
      [siteId, otherSite, workspaceId],
    );
    for (const [hostname, enabled, status] of [
      ['owned.example', true, 'active'],
      ['alias.example', true, 'active'],
      ['disabled.example', false, 'active'],
      ['pending.example', true, 'pending'],
    ]) {
      await pool.query(
        'INSERT INTO "Domain" ("id","siteId","hostname","enabled","status","updatedAt") VALUES ($1,$2,$3,$4,$5,now())',
        [randomUUID(), siteId, hostname, enabled, status],
      );
    }
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM "Lead" WHERE "workspaceId"=$1', [workspaceId]);
    await pool.query('DELETE FROM "AnalyticsEvent" WHERE "workspaceId"=$1', [workspaceId]);
  });
  afterAll(async () => {
    await pool.query('DELETE FROM "Lead" WHERE "workspaceId"=$1', [workspaceId]);
    await pool.query('DELETE FROM "AnalyticsEvent" WHERE "workspaceId"=$1', [workspaceId]);
    await pool.query('DELETE FROM "Domain" WHERE "siteId"=$1', [siteId]);
    await pool.query('DELETE FROM "Site" WHERE "workspaceId"=$1', [workspaceId]);
    await pool.query('DELETE FROM "Workspace" WHERE "id"=$1', [workspaceId]);
    await pool.end();
  });
  it('rejects foreign, missing, non-HTTPS, disabled and pending origins before writing', async () => {
    for (const origin of [
      'https://foreign.example',
      '',
      'http://owned.example',
      'https://disabled.example',
      'https://pending.example',
      'null',
      'https://owned.example/path',
      'https://user@owned.example',
    ])
      expect((await handler(request('leads', undefined, { origin }))).status, origin).toBe(403);
    expect((await pool.query('SELECT id FROM "Lead" WHERE "siteId"=$1', [siteId])).rowCount).toBe(
      0,
    );
  });
  it('accepts all enabled active aliases and scopes ownership from URL and DB', async () => {
    const response = await handler(
      request(
        'leads',
        {
          siteId: otherSite,
          workspaceId: randomUUID(),
          source: 'contact',
          email: 'visitor@example.test',
          message: 'hello',
        },
        { origin: 'https://alias.example' },
      ),
    );
    expect(response.status).toBe(202);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://alias.example');
    expect(
      (await pool.query('SELECT "siteId","workspaceId" FROM "Lead" WHERE "siteId"=$1', [siteId]))
        .rows,
    ).toEqual([{ siteId, workspaceId }]);
  });
  it('deduplicates leads and events without double counting', async () => {
    expect(
      (await handler(request('leads', undefined, { 'x-lead-idempotency-key': 'same' }))).status,
    ).toBe(202);
    expect(
      (await handler(request('leads', undefined, { 'x-lead-idempotency-key': 'same' }))).status,
    ).toBe(200);
    const event = { eventId: randomUUID(), path: '/catalog', visitorId: 'visitor' };
    expect((await handler(request('events', event))).status).toBe(202);
    expect((await handler(request('events', event))).status).toBe(200);
    expect((await pool.query('SELECT id FROM "Lead" WHERE "siteId"=$1', [siteId])).rowCount).toBe(
      1,
    );
    expect(
      (await pool.query('SELECT id FROM "AnalyticsEvent" WHERE "siteId"=$1', [siteId])).rowCount,
    ).toBe(1);
  });
  it('authorizes preflight without writing and never accepts management credentials', async () => {
    const url = `http://localhost/api/v1/sites/${siteId}/leads`;
    const response = await handler(
      new Request(url, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://owned.example',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,x-lead-idempotency-key',
        },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-headers')).not.toContain('authorization');
    expect(
      (await handler(request('leads', undefined, { authorization: 'Bearer private-secret' })))
        .status,
    ).toBe(403);
    expect(
      (
        await handler(
          new Request(url, { method: 'OPTIONS', headers: { origin: 'https://foreign.example' } }),
        )
      ).status,
    ).toBe(403);
    expect((await pool.query('SELECT id FROM "Lead" WHERE "siteId"=$1', [siteId])).rowCount).toBe(
      0,
    );
  });
  it('bounds JSON bodies, rejects invalid input and returns 404 for unknown sites', async () => {
    expect((await handler(request('leads', { message: 'x'.repeat(65536) }))).status).toBe(413);
    expect((await handler(request('leads', { source: 'unknown' }))).status).toBe(400);
    expect((await handler(request('events', { path: '/api/private' }))).status).toBe(400);
    expect((await handler(request('leads', undefined, {}, randomUUID()))).status).toBe(404);
  });
  it('rejects empty leads before writing even when an idempotency key is supplied', async () => {
    for (const body of [
      { source: 'contact' },
      {
        source: 'contact',
        name: 'Visitor',
        email: '',
        phone: '',
        message: '',
        fields: { request: '' },
      },
    ]) {
      const response = await handler(
        request('leads', body, { 'x-lead-idempotency-key': 'empty-retry' }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_payload' });
    }
    expect((await pool.query('SELECT id FROM "Lead" WHERE "siteId"=$1', [siteId])).rowCount).toBe(
      0,
    );
  });
  it('returns non-retryable 400 for malformed visitor and session identifiers without writing', async () => {
    for (const key of ['visitorId', 'sessionId']) {
      for (const invalid of [{ nested: true }, [], 42, true, null, 'x'.repeat(129)]) {
        const response = await handler(request('events', { path: '/catalog', [key]: invalid }));
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'invalid_payload' });
      }
    }
    expect(
      (await pool.query('SELECT id FROM "AnalyticsEvent" WHERE "siteId"=$1', [siteId])).rowCount,
    ).toBe(0);
  });
  it('only accepts explicitly configured loopback origins', async () => {
    const { createIngestHandler } = await import('./http');
    const local = createIngestHandler(pool, { localOrigins: ['http://127.0.0.1:13001'] });
    expect(
      (await local(request('leads', undefined, { origin: 'http://127.0.0.1:13002' }))).status,
    ).toBe(403);
    expect(
      (await local(request('leads', undefined, { origin: 'http://127.0.0.1:13001' }))).status,
    ).toBe(202);
  });
  it('rate limits socket IP and ignores arbitrary forwarded headers', async () => {
    const { createIngestHandler } = await import('./http');
    const socket = createIngestHandler(pool, { clientIp: () => '192.0.2.10' });
    for (let i = 0; i < 5; i++)
      expect(
        (
          await socket(
            request(
              'leads',
              { source: 'contact', email: 'visitor@example.test', message: `message ${i}` },
              { 'x-forwarded-for': `198.51.100.${i}` },
            ),
          )
        ).status,
      ).toBe(202);
    expect(
      (
        await socket(
          request(
            'leads',
            { source: 'contact', message: 'over limit' },
            { 'x-forwarded-for': '198.51.100.99' },
          ),
        )
      ).status,
    ).toBe(429);
    const hashes = await pool.query('SELECT DISTINCT "ipHash" FROM "Lead" WHERE "siteId"=$1', [
      siteId,
    ]);
    expect(hashes.rows).toEqual([
      { ipHash: createHash('sha256').update('192.0.2.10').digest('hex') },
    ]);
  });
  it('enforces the concurrent quota per site and IP while accepting duplicate retries at capacity', async () => {
    const { createIngestHandler } = await import('./http');
    const first = createIngestHandler(pool, { clientIp: () => '192.0.2.50' });
    const body = (index: number) => ({
      source: 'contact',
      email: 'visitor@example.test',
      message: `parallel ${index}`,
    });
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        first(request('leads', body(index), { 'x-lead-idempotency-key': `parallel-${index}` })),
      ),
    );
    expect(responses.filter((response) => response.status === 202)).toHaveLength(5);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(5);
    const accepted = responses.findIndex((response) => response.status === 202);
    expect(
      (
        await first(
          request('leads', body(accepted), { 'x-lead-idempotency-key': `parallel-${accepted}` }),
        )
      ).status,
    ).toBe(200);
    const otherIp = createIngestHandler(pool, { clientIp: () => '192.0.2.51' });
    expect((await otherIp(request('leads', body(20)))).status).toBe(202);
    const otherSiteHandler = createIngestHandler(pool, {
      clientIp: () => '192.0.2.50',
      localOrigins: ['http://127.0.0.1:13001'],
    });
    expect(
      (
        await otherSiteHandler(
          request('leads', body(21), { origin: 'http://127.0.0.1:13001' }, otherSite),
        )
      ).status,
    ).toBe(202);
    expect((await pool.query('SELECT id FROM "Lead" WHERE "siteId"=$1', [siteId])).rowCount).toBe(
      6,
    );
    expect(
      (await pool.query('SELECT id FROM "Lead" WHERE "siteId"=$1', [otherSite])).rowCount,
    ).toBe(1);
  });
  it('serves real Node HTTP and rate limits the socket despite spoofed forwarded IPs', async () => {
    const { createIngestServer } = await import('./server');
    const server = createIngestServer(pool);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const endpoint = `http://127.0.0.1:${address.port}/api/v1/sites/${siteId}/leads`;
    try {
      for (let i = 0; i < 5; i++)
        expect(
          (
            await fetch(endpoint, {
              method: 'POST',
              headers: {
                origin: 'https://owned.example',
                'content-type': 'application/json',
                'x-forwarded-for': `198.51.100.${i}`,
              },
              body: JSON.stringify({
                source: 'contact',
                email: 'visitor@example.test',
                message: `socket ${i}`,
              }),
            })
          ).status,
        ).toBe(202);
      expect(
        (
          await fetch(endpoint, {
            method: 'POST',
            headers: {
              origin: 'https://owned.example',
              'content-type': 'application/json',
              'x-forwarded-for': '198.51.100.99',
            },
            body: JSON.stringify({ source: 'contact', message: 'over limit' }),
          })
        ).status,
      ).toBe(429);
      expect(
        (await pool.query('SELECT DISTINCT "ipHash" FROM "Lead" WHERE "siteId"=$1', [siteId])).rows,
      ).toEqual([{ ipHash: createHash('sha256').update('127.0.0.1').digest('hex') }]);
      expect(
        (
          await fetch(endpoint, {
            method: 'POST',
            headers: { origin: 'https://owned.example', 'content-type': 'application/json' },
            body: JSON.stringify({ message: 'x'.repeat(65536) }),
          })
        ).status,
      ).toBe(413);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(JSON.stringify({ message: 'x'.repeat(65536) })),
          );
          controller.close();
        },
      });
      const streamed = await fetch(endpoint, {
        method: 'POST',
        headers: { origin: 'https://owned.example', 'content-type': 'application/json' },
        body: stream,
        duplex: 'half',
      } as RequestInit);
      expect(streamed.status).toBe(413);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it('returns retryable 503 when PostgreSQL is unavailable', async () => {
    const { createIngestHandler } = await import('./http');
    const offline = new Pool({
      connectionString: 'postgresql://unavailable@127.0.0.1:1/unavailable',
      connectionTimeoutMillis: 100,
    });
    try {
      const response = await createIngestHandler(offline)(request());
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ retryable: true });
    } finally {
      await offline.end();
    }
  });
});
