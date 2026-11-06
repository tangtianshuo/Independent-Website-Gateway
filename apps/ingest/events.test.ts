import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ingestEvent, purgeAnalyticsEvents, validateEvent } from './events.js';

const siteId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';

test('validates and anonymizes a page view', () => {
  const value = validateEvent({
    siteId,
    path: '/products/a',
    visitorId: 'visitor-1',
    sessionId: 'session-1',
    device: 'mobile',
  });
  assert.equal(value.eventType, 'page_view');
  assert.equal(value.visitorHash?.length, 64);
  assert.equal(value.sessionHash?.length, 64);
});

test('rejects unsafe and reserved paths', () => {
  assert.throws(() => validateEvent({ siteId, path: '/api/published' }), /identity/i);
  assert.throws(() => validateEvent({ siteId, path: '/bad\npath' }), /identity/i);
});

test('persists an event without blocking on aggregation', async () => {
  let call = '';
  const pool = {
    query: async (sql: string) => {
      call = sql;
      return { rowCount: 1, rows: [{ id: '55555555-5555-4555-8555-555555555555' }] };
    },
  } as never;
  const result = await ingestEvent(pool, workspaceId, {
    siteId,
    eventId: '33333333-3333-4333-8333-333333333333',
    path: '/',
  });
  assert.match(result.id, /^[0-9a-f-]{36}$/);
  assert.match(call, /INSERT INTO/);
});

test('deduplicates retries and supports bounded retention cleanup', async () => {
  const calls: string[] = [];
  const pool = {
    query: async (sql: string) => {
      calls.push(sql);
      return sql.startsWith('DELETE') ? { rowCount: 2, rows: [] } : { rowCount: 0, rows: [] };
    },
  } as never;
  const first = await ingestEvent(pool, workspaceId, {
    siteId,
    eventId: '44444444-4444-4444-8444-444444444444',
    path: '/',
  });
  assert.equal(first.duplicate, true);
  assert.equal(await purgeAnalyticsEvents(pool, 30), 2);
  await assert.rejects(() => purgeAnalyticsEvents(pool, 0), /retention/i);
  assert.equal(
    calls.some((sql) => sql.includes('ON CONFLICT')),
    true,
  );
});
