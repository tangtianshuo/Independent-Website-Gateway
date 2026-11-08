import type { Pool } from "pg";

export interface PublishLimits {
  maxSiteLeases: number;
  maxWorkspaceLeases: number;
  maxGlobalLeases: number;
  siteStartIntervalMs: number;
}

export const defaultPublishLimits: PublishLimits = {
  maxSiteLeases: 1,
  maxWorkspaceLeases: 2,
  maxGlobalLeases: 4,
  siteStartIntervalMs: 5_000,
};

export function readPublishLimits(
  env: NodeJS.ProcessEnv = process.env,
): PublishLimits {
  const value = (
    name: string,
    fallback: number,
    minimum: number,
    maximum: number,
  ) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
      throw new Error(`Invalid ${name}`);
    return parsed;
  };
  const limits = {
    maxSiteLeases: value(
      "GATEWAY_PUBLISH_SITE_LEASES",
      defaultPublishLimits.maxSiteLeases,
      1,
      20,
    ),
    maxWorkspaceLeases: value(
      "GATEWAY_PUBLISH_WORKSPACE_LEASES",
      defaultPublishLimits.maxWorkspaceLeases,
      1,
      100,
    ),
    maxGlobalLeases: value(
      "GATEWAY_PUBLISH_GLOBAL_LEASES",
      defaultPublishLimits.maxGlobalLeases,
      1,
      500,
    ),
    siteStartIntervalMs: value(
      "GATEWAY_PUBLISH_SITE_INTERVAL_MS",
      defaultPublishLimits.siteStartIntervalMs,
      1_000,
      300_000,
    ),
  };
  if (
    limits.maxSiteLeases > limits.maxWorkspaceLeases ||
    limits.maxWorkspaceLeases > limits.maxGlobalLeases
  )
    throw new Error("Inconsistent publish limits");
  return limits;
}

export interface ClaimedOperation {
  id: string;
  siteId: string;
  workspaceId: string;
  releaseId: string;
  desiredRevision: number;
  leaseOwner: string;
  leaseUntil: Date;
  attempts: number;
}

export async function claimPublishOperation(
  pool: Pool,
  workerId: string,
  leaseSeconds: number,
  limits: PublishLimits = defaultPublishLimits,
): Promise<ClaimedOperation | null> {
  if (
    !workerId ||
    !Number.isSafeInteger(leaseSeconds) ||
    leaseSeconds < 1 ||
    leaseSeconds > 3600
  )
    throw new Error("Invalid lease");
  if (
    ![
      limits.maxSiteLeases,
      limits.maxWorkspaceLeases,
      limits.maxGlobalLeases,
      limits.siteStartIntervalMs,
    ].every((value) => Number.isSafeInteger(value) && value > 0)
  )
    throw new Error("Invalid publish limits");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // One short transaction serializes capacity decisions. Docker and HTTP work remain outside it.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('gateway.publish.scheduler'))",
    );
    const result = await client.query<ClaimedOperation>(
      `
      WITH active AS (
        SELECT operation."siteId", operation."workspaceId"
        FROM "PublishOperation" operation
        WHERE operation."status" = 'pending' AND operation."leaseUntil" > clock_timestamp()
      ), candidate AS (
        SELECT operation."id"
        FROM "PublishOperation" operation
        JOIN "Site" site ON site."id" = operation."siteId" AND site."workspaceId" = operation."workspaceId"
        WHERE operation."status" = 'pending'
          AND (operation."leaseUntil" IS NULL OR operation."leaseUntil" < clock_timestamp())
          AND (operation."nextAttemptAt" IS NULL OR operation."nextAttemptAt" <= clock_timestamp())
          AND operation."failureCode" IS DISTINCT FROM 'ROUTE_SWITCH_FAILED'
          AND NOT EXISTS (
            SELECT 1 FROM active WHERE active."siteId" = operation."siteId"
          )
          AND (SELECT COUNT(*) FROM active) < $3
          AND (SELECT COUNT(*) FROM active WHERE active."workspaceId" = operation."workspaceId") < $4
          AND (site."lastPublishStartedAt" IS NULL OR
            site."lastPublishStartedAt" <= clock_timestamp() - $5::integer * interval '1 millisecond')
          AND NOT EXISTS (
            SELECT 1 FROM "DomainChange" change
            WHERE change."siteId" = operation."siteId" AND change."status" = 'pending'
          )
        ORDER BY site."lastPublishStartedAt" NULLS FIRST, operation."createdAt", operation."id"
        FOR UPDATE OF operation SKIP LOCKED
        LIMIT 1
      )
      UPDATE "PublishOperation" AS operation
      SET "leaseOwner" = $1, "leaseUntil" = clock_timestamp() + $2 * interval '1 second',
          "attempts" = operation."attempts" + 1, "failureCode" = NULL,
          "nextAttemptAt" = NULL, "updatedAt" = clock_timestamp()
      FROM candidate WHERE operation."id" = candidate."id"
      RETURNING operation."id", operation."siteId", operation."workspaceId", operation."releaseId",
        operation."desiredRevision", operation."leaseOwner", operation."leaseUntil", operation."attempts"
    `,
      [
        workerId,
        leaseSeconds,
        limits.maxGlobalLeases,
        limits.maxWorkspaceLeases,
        limits.siteStartIntervalMs,
      ],
    );
    const claimed = result.rows[0] ?? null;
    if (claimed) {
      await client.query(
        'UPDATE "Site" SET "lastPublishStartedAt" = clock_timestamp() WHERE "id" = $1',
        [claimed.siteId],
      );
    }
    await client.query("COMMIT");
    return claimed;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
