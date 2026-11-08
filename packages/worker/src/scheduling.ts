import type { Pool } from "pg";
import {
  claimPublishOperation,
  readPublishLimits,
  type PublishLimits,
} from "./claim.js";
import { processDomainChange } from "./domain-changes.js";

interface ReconciliationRouter {
  readRoute(
    siteId: string,
  ): Promise<{ releaseId?: string; revision: number } | undefined>;
}

/**
 * A route switch whose outcome is unknown must be reconciled before another
 * candidate is deployed. The SQL active tuple is authoritative. A route file
 * pointing at the target while SQL remains old is ambiguous and stays blocked.
 */
export async function reconcileUnknownPublishRoutes(
  pool: Pool,
  router: ReconciliationRouter,
): Promise<{ settled: number; pending: number }> {
  const client = await pool.connect();
  let settled = 0;
  let pending = 0;
  try {
    await client.query("BEGIN");
    const operations = await client.query<{
      id: string;
      siteId: string;
      releaseId: string;
      desiredRevision: number;
      failureCode: string | null;
    }>(`SELECT "id", "siteId", "releaseId", "desiredRevision", "failureCode"
      FROM "PublishOperation"
      WHERE "status"='pending' AND ("failureCode"='ROUTE_SWITCH_FAILED' OR "failureCode" IS NULL)
        AND ("leaseUntil" IS NULL OR "leaseUntil" < clock_timestamp())
      ORDER BY "updatedAt", "id"
      FOR UPDATE SKIP LOCKED LIMIT 20`);
    for (const operation of operations.rows) {
      const active = await client.query<{
        releaseId: string;
        routeRevision: number;
      }>(
        'SELECT "releaseId", "routeRevision" FROM "ActiveDeployment" WHERE "siteId"=$1',
        [operation.siteId],
      );
      const current = active.rows[0] ?? null;
      let route;
      try {
        route = await router.readRoute(operation.siteId);
      } catch {
        pending++;
        continue;
      }
      if (
        current &&
        current.releaseId === operation.releaseId &&
        current.routeRevision === operation.desiredRevision &&
        route &&
        route.releaseId === operation.releaseId &&
        route.revision === operation.desiredRevision
      ) {
        await client.query(
          `UPDATE "PublishOperation"
          SET "status"='ready',"failureCode"=NULL,"lastFailureCode"=NULL,"nextAttemptAt"=NULL,
            "leaseOwner"=NULL,"leaseUntil"=NULL,"candidateCredentialHash"=NULL,"updatedAt"=clock_timestamp()
          WHERE "id"=$1 AND "status"='pending'`,
          [operation.id],
        );
        await client.query(
          `UPDATE "Publication" SET "activeReleaseId"=$1,"routeRevision"=$2,
          "status"='active',"updatedAt"=clock_timestamp()
          WHERE "siteId"=$3 AND "desiredReleaseId"=$1 AND "desiredRevision"=$2`,
          [operation.releaseId, operation.desiredRevision, operation.siteId],
        );
        settled++;
        continue;
      }
      const oldRouteProven =
        !route ||
        (current !== null &&
          route.releaseId === current.releaseId &&
          route.revision === current.routeRevision);
      if (oldRouteProven) {
        if (operation.failureCode === "ROUTE_SWITCH_FAILED") {
          await client.query(
            `UPDATE "PublishOperation"
            SET "failureCode"=NULL,"lastFailureCode"='route_reconciled_old_active',
              "nextAttemptAt"=clock_timestamp()+interval '5 seconds',"updatedAt"=clock_timestamp()
            WHERE "id"=$1 AND "status"='pending' AND "failureCode"='ROUTE_SWITCH_FAILED'`,
            [operation.id],
          );
        }
        settled++;
      } else {
        await client.query(
          `UPDATE "PublishOperation"
          SET "failureCode"='ROUTE_SWITCH_FAILED',"lastFailureCode"='route_reconciliation_required',
            "nextAttemptAt"=NULL,"updatedAt"=clock_timestamp()
          WHERE "id"=$1 AND "status"='pending'
            AND ("leaseUntil" IS NULL OR "leaseUntil" < clock_timestamp())`,
          [operation.id],
        );
        pending++;
      }
    }
    await client.query("COMMIT");
    return { settled, pending };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** One production scheduling step: domain work precedes publication claiming. */
export async function scheduleWorkerOperations(
  pool: Pool,
  router: Parameters<typeof processDomainChange>[1],
  workerId: string,
  verify?: Parameters<typeof processDomainChange>[2],
  limits: PublishLimits = readPublishLimits(),
) {
  await reconcileUnknownPublishRoutes(pool, router);
  await processDomainChange(pool, router, verify);
  return claimPublishOperation(pool, workerId, 180, limits);
}
