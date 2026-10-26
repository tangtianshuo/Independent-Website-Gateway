import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { persistCandidateCredential } from './operations.js';

test('persists only credential hash while current lease is valid', async () => {
  let sql = ''; let values: unknown[] = [];
  const pool = { query: async (text: string, params: unknown[]) => { sql = text; values = params; return { rowCount: 1 }; } };
  const token = 'a'.repeat(64);
  assert.equal(await persistCandidateCredential(pool as never, { operationId: randomUUID(), workerId: 'worker', attempts: 1, leaseUntil: new Date(Date.now() + 60000), credential: token }), true);
  assert.match(sql, /"candidateCredentialHash"/);
  assert.match(sql, /"leaseUntil" > clock_timestamp\(\)/);
  assert.ok(!values.includes(token));
  assert.match(values[0] as string, /^[a-f0-9]{64}$/);
});
