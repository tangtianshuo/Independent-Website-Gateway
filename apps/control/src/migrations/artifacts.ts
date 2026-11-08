import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const release = /^[a-zA-Z0-9._-]{1,128}$/;
const digest = /^sha256:[a-f0-9]{64}$/;

export interface MigrationArtifactInput {
  siteId: string;
  releaseId: string;
  checksum: string;
  manifestChecksum: string;
  rendererDigest: string;
  snapshotRef?: string;
  assetManifestRef?: string;
}

export interface MigrationArtifactRecord {
  id: string;
  siteId: string;
  releaseId: string;
  snapshotRef: string | null;
  checksum: string;
  assetManifestRef: string | null;
  rendererDigest: string | null;
  status: string;
}

export class ArtifactIdentityConflict extends Error {
  readonly status = 409;

  constructor(message = "artifact_identity_conflict") {
    super(message);
    this.name = "ArtifactIdentityConflict";
  }
}

function valid(input: MigrationArtifactInput): void {
  if (
    !uuid.test(input.siteId) ||
    !release.test(input.releaseId) ||
    !digest.test(input.checksum) ||
    !digest.test(input.manifestChecksum) ||
    !digest.test(input.rendererDigest) ||
    (input.snapshotRef !== undefined &&
      (typeof input.snapshotRef !== "string" ||
        !input.snapshotRef ||
        input.snapshotRef.length > 1024)) ||
    (input.assetManifestRef !== undefined &&
      (typeof input.assetManifestRef !== "string" ||
        !input.assetManifestRef ||
        input.assetManifestRef.length > 1024))
  ) {
    throw new TypeError("Invalid migration artifact identity");
  }
}

function same(
  existing: MigrationArtifactRecord,
  input: MigrationArtifactInput,
): boolean {
  return (
    existing.checksum === input.checksum &&
    existing.assetManifestRef ===
      (input.assetManifestRef ?? input.manifestChecksum) &&
    existing.rendererDigest === input.rendererDigest &&
    (input.snapshotRef === undefined ||
      existing.snapshotRef === null ||
      existing.snapshotRef === input.snapshotRef)
  );
}

/**
 * Persist the immutable artifact identity used by a per-site legacy migration.
 * The database uniqueness key is (siteId, releaseId); equal retries return the
 * original row and any identity change is a conflict.
 */
export async function ensureMigrationArtifactRecord(
  client: PoolClient,
  input: MigrationArtifactInput,
): Promise<MigrationArtifactRecord> {
  valid(input);
  const site = await client.query(
    'SELECT "id" FROM "Site" WHERE "id" = $1 FOR UPDATE',
    [input.siteId],
  );
  if (!site.rowCount) throw new ArtifactIdentityConflict("site_not_found");
  const result = await client.query<MigrationArtifactRecord>(
    `SELECT "id", "siteId", "releaseId", "snapshotRef", "checksum",
      "assetManifestRef", "rendererDigest", "status" FROM "ReleaseArtifact"
      WHERE "siteId" = $1 AND "releaseId" = $2 FOR UPDATE`,
    [input.siteId, input.releaseId],
  );
  let artifact: MigrationArtifactRecord;
  if (result.rowCount) {
    artifact = result.rows[0];
    if (!same(artifact, input)) throw new ArtifactIdentityConflict();
    if (artifact.snapshotRef === null && input.snapshotRef) {
      const updated = await client.query<MigrationArtifactRecord>(
        `UPDATE "ReleaseArtifact" SET "snapshotRef" = $1, "status" = 'available', "updatedAt" = now()
          WHERE "id" = $2 RETURNING "id", "siteId", "releaseId", "snapshotRef", "checksum", "assetManifestRef", "rendererDigest", "status`,
        [input.snapshotRef, artifact.id],
      );
      artifact = updated.rows[0];
    }
  } else {
    const inserted = await client.query<MigrationArtifactRecord>(
      `INSERT INTO "ReleaseArtifact"
        ("id", "siteId", "releaseId", "snapshotRef", "checksum", "assetManifestRef", "rendererDigest", "status", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
        RETURNING "id", "siteId", "releaseId", "snapshotRef", "checksum", "assetManifestRef", "rendererDigest", "status"`,
      [
        randomUUID(),
        input.siteId,
        input.releaseId,
        input.snapshotRef ?? null,
        input.checksum,
        input.assetManifestRef ?? input.manifestChecksum,
        input.rendererDigest,
        input.snapshotRef ? "available" : "invalid",
      ],
    );
    artifact = inserted.rows[0];
  }
  return artifact;
}

export async function ensureMigrationArtifact(
  pool: Pool,
  input: MigrationArtifactInput,
): Promise<MigrationArtifactRecord> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const artifact = await ensureMigrationArtifactRecord(client, input);
    await client.query("COMMIT");
    return artifact;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
