import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const failureCodes = new Set(['CANDIDATE_CREATE_FAILED', 'CANDIDATE_START_FAILED', 'CANDIDATE_UNHEALTHY', 'ROUTE_SWITCH_FAILED', 'WORKER_INTERNAL_ERROR']);

export interface FailureInput { operationId: string; workerId: string; attempts: number; leaseUntil: Date; failureCode: string }
export interface FinalizeInput { operationId: string; workerId: string; attempts: number; leaseUntil: Date; imageDigest: string; imageRepository?: string; sourceCommit?: string; manifestChecksum?: string; host?: string }
export interface CredentialInput { operationId: string; workerId: string; attempts: number; leaseUntil: Date; credential: string }

export async function persistCandidateCredential(pool: Pool, input: CredentialInput): Promise<boolean> {
  if (!uuidPattern.test(input.operationId) || !input.workerId || input.workerId.length > 128 ||
      !Number.isSafeInteger(input.attempts) || input.attempts < 1 ||
      !(input.leaseUntil instanceof Date) || !Number.isFinite(input.leaseUntil.getTime()) ||
      !/^[a-f0-9]{64}$/.test(input.credential)) throw new Error('Invalid candidate credential lease');
  const hash = createHash('sha256').update(input.credential).digest('hex');
  const result = await pool.query(`UPDATE "PublishOperation" SET "candidateCredentialHash" = $1, "updatedAt" = now()
    WHERE "id" = $2 AND "leaseOwner" = $3 AND "attempts" = $4 AND "leaseUntil" > clock_timestamp()
      AND date_trunc('milliseconds', "leaseUntil") = $5 AND "status" = 'pending'`,
  [hash, input.operationId, input.workerId, input.attempts, input.leaseUntil]);
  return result.rowCount === 1;
}

export async function failPublishOperation(pool: Pool, input: FailureInput): Promise<boolean> {
  if (!uuidPattern.test(input.operationId)) throw new Error('Invalid operation ID');
  if (!input.workerId || input.workerId.length > 128) throw new Error('Invalid worker ID');
  if (!Number.isSafeInteger(input.attempts) || input.attempts < 1) throw new Error('Invalid lease attempt');
  if (!(input.leaseUntil instanceof Date) || !Number.isFinite(input.leaseUntil.getTime())) throw new Error('Invalid lease expiry');
  if (!failureCodes.has(input.failureCode)) throw new Error('Invalid failure code');
  const result = await pool.query(`UPDATE "PublishOperation"
    SET "status" = $1, "failureCode" = $2, "leaseOwner" = NULL, "leaseUntil" = NULL,
        "candidateCredentialHash" = NULL, "updatedAt" = now()
    WHERE "id" = $3 AND "leaseOwner" = $4 AND "attempts" = $5
      AND "leaseUntil" > clock_timestamp() AND date_trunc('milliseconds', "leaseUntil") = $6
      AND "status" = 'pending'`, ['failed', input.failureCode, input.operationId, input.workerId, input.attempts, input.leaseUntil]);
  if (result.rowCount === 1) {
    await pool.query(`UPDATE "Publication" publication SET "status" = 'failed', "updatedAt" = now()
      FROM "PublishOperation" operation
      WHERE operation."id" = $1 AND publication."siteId" = operation."siteId"
        AND publication."desiredRevision" = operation."desiredRevision"
        AND publication."desiredReleaseId" = operation."releaseId"`, [input.operationId]);
  }
  return result.rowCount === 1;
}

export async function finalizeAfterRouteVerification(pool: Pool, input: FinalizeInput): Promise<boolean> {
  if (!uuidPattern.test(input.operationId)) throw new Error('Invalid operation ID');
  if (!input.workerId || input.workerId.length > 128) throw new Error('Invalid worker ID');
  if (!Number.isSafeInteger(input.attempts) || input.attempts < 1) throw new Error('Invalid lease attempt');
  if (!(input.leaseUntil instanceof Date) || !Number.isFinite(input.leaseUntil.getTime())) throw new Error('Invalid lease expiry');
  if (!digestPattern.test(input.imageDigest)) throw new Error('Invalid image digest');
  if (input.host !== undefined && (!input.host || input.host.length > 253 || /[^a-zA-Z0-9.:-]/.test(input.host))) throw new Error('Invalid deployment host');
  const publicImage = input.imageRepository !== undefined;
  if (publicImage ? !/^ghcr\.io\/tangtianshuo\/independent-website-templates\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.imageRepository!) ||
      !/^[a-f0-9]{40}$/.test(input.sourceCommit ?? '') || !digestPattern.test(input.manifestChecksum ?? '')
    : input.sourceCommit !== undefined || input.manifestChecksum !== undefined) throw new Error('Invalid public pin identity');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const operation = await client.query<{ siteId: string; releaseId: string; desiredRevision: number }>(`
      SELECT "siteId", "releaseId", "desiredRevision" FROM "PublishOperation"
      WHERE "id" = $1 AND "leaseOwner" = $2 AND "attempts" = $3
        AND "leaseUntil" > clock_timestamp() AND date_trunc('milliseconds', "leaseUntil") = $4
        AND "status" = 'pending' FOR UPDATE
    `, [input.operationId, input.workerId, input.attempts, input.leaseUntil]);
    if (!operation.rowCount) return false;
    const { siteId, releaseId, desiredRevision } = operation.rows[0];
    const site = await client.query(`SELECT "id" FROM "Site" WHERE "id" = $1 AND "desiredRevision" = $2
        AND "desiredReleaseId" = $3 FOR UPDATE`, [siteId, desiredRevision, releaseId]);
    if (!site.rowCount) return false;
    // Backfill an artifact for a legacy Release that predates the split model.
    // This keeps old queued publish operations recoverable after the migration.
    await client.query(`INSERT INTO "ReleaseArtifact"
      ("id", "siteId", "releaseId", "snapshotRef", "checksum", "assetManifestRef", "rendererDigest", "status", "updatedAt")
      SELECT gen_random_uuid(), release."siteId", release."releaseId", release."snapshotRef", release."checksum",
        release."metadata"->>'manifestChecksum', release."metadata"->>'imageDigest',
        CASE WHEN release."snapshotRef" IS NULL THEN 'invalid' ELSE 'available' END, now()
      FROM "Release" release
      WHERE release."siteId" = $1 AND release."releaseId" = $2
      ON CONFLICT ("siteId", "releaseId") DO NOTHING`, [siteId, releaseId]);
    const release = await client.query(`SELECT artifact."id" AS "artifactId" FROM "Release" AS release
      JOIN "ReleaseArtifact" AS artifact ON artifact."siteId" = release."siteId" AND artifact."releaseId" = release."releaseId"
      JOIN "TemplatePin" AS pin ON pin."siteId" = release."siteId"
        AND pin."templateId" = release."metadata"->>'templateId'
        AND pin."version" = release."metadata"->>'templateVersion'
        AND pin."imageDigest" = release."metadata"->>'imageDigest'
        AND (($4::text IS NULL AND pin."imageRepository" IS NULL AND pin."manifestChecksum" IS NULL AND pin."sourceCommit" IS NULL)
          OR ($4::text IS NOT NULL AND pin."imageRepository" = $4 AND pin."sourceCommit" = $5
            AND pin."manifestChecksum" = $6 AND pin."manifestChecksum" = release."metadata"->>'manifestChecksum'))
      WHERE release."siteId" = $1 AND release."releaseId" = $2
        AND release."snapshotRef" IS NOT NULL AND pin."imageDigest" = $3
      FOR UPDATE OF release, pin`, [siteId, releaseId, input.imageDigest, input.imageRepository ?? null, input.sourceCommit ?? null, input.manifestChecksum ?? null]);
    if (!release.rowCount) return false;
    await client.query(`INSERT INTO "ActiveDeployment" ("id", "siteId", "releaseId", "imageDigest", "routeRevision")
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT ("siteId") DO UPDATE SET "releaseId" = EXCLUDED."releaseId",
        "imageDigest" = EXCLUDED."imageDigest", "routeRevision" = EXCLUDED."routeRevision",
        "activatedAt" = now()`, [input.operationId, siteId, releaseId, input.imageDigest, desiredRevision]);
    await client.query(`INSERT INTO "Deployment"
      ("id", "siteId", "releaseId", "artifactId", "imageDigest", "host", "healthStatus", "routeRevision", "activatedAt")
      VALUES ($1, $2, $3, $4, $5, $6, 'healthy', $7, now())
      ON CONFLICT ("id") DO UPDATE SET "imageDigest" = EXCLUDED."imageDigest", "host" = EXCLUDED."host",
        "healthStatus" = 'healthy', "routeRevision" = EXCLUDED."routeRevision", "activatedAt" = now()`,
      [input.operationId, siteId, releaseId, release.rows[0].artifactId, input.imageDigest, input.host ?? null, desiredRevision]);
    await client.query(`INSERT INTO "Publication"
      ("siteId", "desiredReleaseId", "activeReleaseId", "desiredRevision", "routeRevision", "status", "updatedAt")
      VALUES ($1, $2, $2, $3, $3, 'active', now())
      ON CONFLICT ("siteId") DO UPDATE SET "desiredReleaseId" = EXCLUDED."desiredReleaseId",
        "activeReleaseId" = EXCLUDED."activeReleaseId", "desiredRevision" = EXCLUDED."desiredRevision",
        "routeRevision" = EXCLUDED."routeRevision", "status" = 'active', "updatedAt" = now()`,
      [siteId, releaseId, desiredRevision]);
    await client.query(`UPDATE "Site" SET "credentialHash" = operation."candidateCredentialHash", "updatedAt" = now()
      FROM "PublishOperation" operation WHERE "Site"."id" = $1 AND operation."id" = $2
        AND operation."candidateCredentialHash" IS NOT NULL`, [siteId, input.operationId]);
    const ready = await client.query(`UPDATE "PublishOperation" SET "status" = 'ready', "failureCode" = NULL,
        "leaseOwner" = NULL, "leaseUntil" = NULL, "candidateCredentialHash" = NULL, "updatedAt" = now()
      WHERE "id" = $1 AND "leaseOwner" = $2 AND "attempts" = $3
        AND "leaseUntil" > clock_timestamp() AND date_trunc('milliseconds', "leaseUntil") = $4
        AND "status" = 'pending' AND "candidateCredentialHash" IS NOT NULL`, [input.operationId, input.workerId, input.attempts, input.leaseUntil]);
    if (ready.rowCount !== 1) return false;
    await client.query('COMMIT');
    return true;
  } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
}
