import assert from 'node:assert/strict';
import { test } from 'vitest';
import { validateLead, ingestLead } from './leads.js';

const siteId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';

test('validates a bounded structured lead and derives a stable dedupe key', () => {
  const first = validateLead({
    siteId,
    source: 'contact',
    email: ' SALES@EXAMPLE.COM ',
    message: 'Need a quote',
    fields: { budget: '10k' },
  });
  const second = validateLead({
    siteId,
    source: 'contact',
    email: 'sales@example.com',
    message: 'Need a quote',
    fields: { budget: '10k' },
  });
  assert.equal(first.dedupeKey, second.dedupeKey);
  assert.equal(first.email, 'SALES@EXAMPLE.COM');
});

test('rejects unsupported sources, unsafe fields and honeypot submissions', () => {
  assert.throws(() => validateLead({ siteId, source: 'spam', message: 'x' }), /source/i);
  assert.throws(
    () => validateLead({ siteId, source: 'contact', message: '<script>x</script>' }),
    /message/i,
  );
  assert.throws(
    () => validateLead({ siteId, source: 'contact', message: 'x', honeypot: 'filled' }),
    /rejected/i,
  );
});

test('rejects leads without substantive details even with a retry key', () => {
  for (const body of [
    {},
    { email: '', phone: '', message: '', fields: {} },
    { fields: { request: '' } },
    { name: 'Visitor', idempotencyKey: 'retry-key' },
  ]) {
    assert.throws(
      () => validateLead({ siteId, source: 'contact', ...body }),
      /requires contact details/i,
    );
  }
});

test('accepts a contact, message or substantive custom field independently', () => {
  for (const details of [
    { email: 'visitor@example.test' },
    { phone: '123456789' },
    { message: 'Please call' },
    { fields: { request: 'A quote' } },
  ]) {
    assert.doesNotThrow(() => validateLead({ siteId, source: 'contact', ...details }));
  }
});

test('persists a lead once, reports duplicates and rate limits an IP', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT COUNT')) return { rows: [{ count: '0' }], rowCount: 1 };
    if (sql.startsWith('SELECT "id"'))
      return calls.some((item) => item.sql.startsWith('INSERT'))
        ? { rowCount: 1, rows: [{ id: 'lead-1' }] }
        : { rowCount: 0, rows: [] };
    if (sql.startsWith('INSERT'))
      return { rowCount: 1, rows: [{ id: 'lead-1', notificationStatus: 'pending' }] };
    return { rowCount: 0, rows: [] };
  };
  const pool = { connect: async () => ({ query, release: () => undefined }) } as never;
  const input = { siteId, source: 'quote', email: 'sales@example.com', message: 'Hello' };
  assert.deepEqual(await ingestLead(pool, workspaceId, input, { ip: '127.0.0.1' }), {
    id: 'lead-1',
    duplicate: false,
    status: 'new',
    notificationStatus: 'pending',
  });
  assert.deepEqual(await ingestLead(pool, workspaceId, input, { ip: '127.0.0.1' }), {
    id: 'lead-1',
    duplicate: true,
    status: 'duplicate',
    notificationStatus: 'pending',
  });
  assert.match(calls.find((item) => item.sql.startsWith('INSERT'))!.sql, /ON CONFLICT/);
});
