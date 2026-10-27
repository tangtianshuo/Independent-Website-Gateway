import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pullApprovedImage } from './pull.js';

test('records a bounded operation failure when an approved public image pull fails', async () => {
  let failureRecorded = false;
  const pulled = await pullApprovedImage(
    async () => { throw new Error('registry unavailable'); },
    async () => { failureRecorded = true; },
  );
  assert.equal(pulled, false);
  assert.equal(failureRecorded, true);
});

test('does not record failure after a successful pull', async () => {
  let failureRecorded = false;
  const pulled = await pullApprovedImage(async () => undefined, async () => { failureRecorded = true; });
  assert.equal(pulled, true);
  assert.equal(failureRecorded, false);
});
