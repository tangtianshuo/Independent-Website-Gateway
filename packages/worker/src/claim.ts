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
      SELECT operation."id" FROM "PublishOperation" operation
      WHERE operation."status" = 'pending' AND (operation."leaseUntil" IS NULL OR operation."leaseUntil" < now())
        AND NOT EXISTS (SELECT 1 FROM "DomainChange" change WHERE change."siteId"=operation."siteId" AND change."status"='pending')
      ORDER BY operation."createdAt", operation."id"
      FOR UPDATE OF operation SKIP LOCKED
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
