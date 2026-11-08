import type { Pool } from "pg";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Read-only operational metric. This does not participate in publish decisions. */
export async function readPublishFailureCount15m(
  pool: Pick<Pool, "query">,
  siteId: string,
): Promise<number> {
  if (!uuidPattern.test(siteId)) throw new Error("Invalid siteId");
  const result = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::integer AS "count"
    FROM "PublishOperation"
    WHERE "siteId" = $1 AND "status" = 'failed'
      AND "updatedAt" >= now() - interval '15 minutes'`,
    [siteId],
  );
  const count = result.rows[0]?.count;
  if (!Number.isSafeInteger(count) || count < 0)
    throw new Error("Invalid failure count");
  return count;
}

export interface PublishQueueObservation {
  sitePending: number;
  workspacePending: number;
  globalPending: number;
  siteActiveLeases: number;
  workspaceActiveLeases: number;
  globalActiveLeases: number;
}

/** Read-only queue capacity snapshot used by monitoring. */
export async function readPublishQueueObservation(
  pool: Pick<Pool, "query">,
  siteId: string,
  workspaceId: string,
): Promise<PublishQueueObservation> {
  if (!uuidPattern.test(siteId) || !uuidPattern.test(workspaceId))
    throw new Error("Invalid publish queue scope");
  const result = await pool.query<PublishQueueObservation>(
    `SELECT
      COUNT(*) FILTER (WHERE "siteId" = $1)::integer AS "sitePending",
      COUNT(*) FILTER (WHERE "workspaceId" = $2)::integer AS "workspacePending",
      COUNT(*)::integer AS "globalPending",
      COUNT(*) FILTER (WHERE "siteId" = $1 AND "leaseUntil" > clock_timestamp())::integer AS "siteActiveLeases",
      COUNT(*) FILTER (WHERE "workspaceId" = $2 AND "leaseUntil" > clock_timestamp())::integer AS "workspaceActiveLeases",
      COUNT(*) FILTER (WHERE "leaseUntil" > clock_timestamp())::integer AS "globalActiveLeases"
    FROM "PublishOperation"
    WHERE "status" = 'pending'`,
    [siteId, workspaceId],
  );
  const row = result.rows[0];
  const fields: Array<keyof PublishQueueObservation> = [
    "sitePending",
    "workspacePending",
    "globalPending",
    "siteActiveLeases",
    "workspaceActiveLeases",
    "globalActiveLeases",
  ];
  if (
    !row ||
    fields.some((field) => !Number.isSafeInteger(row[field]) || row[field] < 0)
  )
    throw new Error("Invalid publish queue observation");
  return Object.fromEntries(
    fields.map((field) => [field, row[field]]),
  ) as unknown as PublishQueueObservation;
}
