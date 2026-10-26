import type { Pool } from 'pg';

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

export async function claimPublishOperation(pool: Pool, workerId: string, leaseSeconds: number): Promise<ClaimedOperation | null> {
  if (!workerId || !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) throw new Error('Invalid lease');
  const result = await pool.query<ClaimedOperation>(`
    WITH candidate AS (
      SELECT "id" FROM "PublishOperation"
      WHERE "status" = 'pending' AND ("leaseUntil" IS NULL OR "leaseUntil" < now())
      ORDER BY "createdAt", "id"
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE "PublishOperation" AS operation
    SET "leaseOwner" = $1, "leaseUntil" = now() + $2 * interval '1 second',
        "attempts" = operation."attempts" + 1, "updatedAt" = now()
    FROM candidate WHERE operation."id" = candidate."id"
    RETURNING operation."id", operation."siteId", operation."workspaceId", operation."releaseId",
      operation."desiredRevision", operation."leaseOwner", operation."leaseUntil", operation."attempts"
  `, [workerId, leaseSeconds]);
  return result.rows[0] ?? null;
}
