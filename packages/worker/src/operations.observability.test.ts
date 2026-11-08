import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import {
  readPublishFailureCount15m,
  readPublishQueueObservation,
} from "./operations.js";

const siteId = "123e4567-e89b-42d3-a456-426614174000";

test("counts only failed operations in the authoritative fifteen-minute window", async () => {
  let sql = "";
  let values: unknown[] = [];
  const pool = {
    query: async (statement: string, parameters: unknown[]) => {
      sql = statement;
      values = parameters;
      return { rowCount: 1, rows: [{ count: 3 }] };
    },
  } as unknown as Pool;

  assert.equal(await readPublishFailureCount15m(pool, siteId), 3);
  assert.match(sql, /status"\s*=\s*'failed'/);
  assert.match(sql, /updatedAt"\s*>=\s*now\(\)\s*-\s*interval '15 minutes'/);
  assert.deepEqual(values, [siteId]);
});

test("fails closed on an invalid site or malformed count", async () => {
  const pool = {
    query: async () => ({ rowCount: 1, rows: [{ count: -1 }] }),
  } as unknown as Pool;
  await assert.rejects(
    () => readPublishFailureCount15m(pool, "not-a-site"),
    /siteId/,
  );
  await assert.rejects(
    () => readPublishFailureCount15m(pool, siteId),
    /failure count/,
  );
});

test("reads bounded pending and active queue counts without changing state", async () => {
  const workspaceId = "123e4567-e89b-42d3-a456-426614174001";
  let sql = "";
  let values: unknown[] = [];
  const pool = {
    query: async (statement: string, parameters: unknown[]) => {
      sql = statement;
      values = parameters;
      return {
        rowCount: 1,
        rows: [
          {
            sitePending: 2,
            workspacePending: 5,
            globalPending: 7,
            siteActiveLeases: 1,
            workspaceActiveLeases: 1,
            globalActiveLeases: 2,
          },
        ],
      };
    },
  } as unknown as Pool;
  assert.deepEqual(
    await readPublishQueueObservation(pool, siteId, workspaceId),
    {
      sitePending: 2,
      workspacePending: 5,
      globalPending: 7,
      siteActiveLeases: 1,
      workspaceActiveLeases: 1,
      globalActiveLeases: 2,
    },
  );
  assert.match(sql, /FROM "PublishOperation"/);
  assert.match(sql, /"status" = 'pending'/);
  assert.deepEqual(values, [siteId, workspaceId]);
});
