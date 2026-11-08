import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ArtifactIdentityConflict,
  ensureMigrationArtifact,
} from "../src/migrations/artifacts";

const connectionString = process.env.GATEWAY_TEST_DATABASE_URL;
const run = connectionString ? describe : describe.skip;

run("legacy migration artifact PostgreSQL integration", () => {
  const pool = new Pool({ connectionString });
  const workspaceId = randomUUID();
  const siteId = randomUUID();
  const checksum = `sha256:${"a".repeat(64)}`;
  const manifestChecksum = `sha256:${"b".repeat(64)}`;
  const rendererDigest = `sha256:${"c".repeat(64)}`;
  let directory: string;
  let receiveRelease: (request: Request, siteId: string) => Promise<Response>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "artifact-migration-"));
    process.env.DATABASE_URL = connectionString;
    process.env.SNAPSHOT_STORAGE_PATH = directory;
    process.env.CMS_SERVICE_SECRET = "artifact-integration-secret";
    process.env.CMS_WORKSPACE_ID = workspaceId;
    process.env.ALLOWED_TEMPLATE_IDS = "example";
    ({ receiveRelease } = await import("../src/releases"));
    await pool.query(
      'INSERT INTO "Workspace" ("id", "name", "updatedAt") VALUES ($1, $2, now())',
      [workspaceId, "artifact migration"],
    );
    await pool.query(
      'INSERT INTO "Site" ("id", "workspaceId", "updatedAt") VALUES ($1, $2, now())',
      [siteId, workspaceId],
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM "ReleaseArtifact" WHERE "siteId" = $1', [
      siteId,
    ]);
    await pool.query('DELETE FROM "Site" WHERE "id" = $1', [siteId]);
    await pool.query('DELETE FROM "Workspace" WHERE "id" = $1', [workspaceId]);
    await pool.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("creates once, replays the same identity and rejects changed bytes", async () => {
    const first = await ensureMigrationArtifact(pool, {
      siteId,
      releaseId: "legacy-release",
      checksum,
      manifestChecksum,
      rendererDigest,
      snapshotRef: "/private/legacy-release.json",
    });
    const second = await ensureMigrationArtifact(pool, {
      siteId,
      releaseId: "legacy-release",
      checksum,
      manifestChecksum,
      rendererDigest,
      snapshotRef: "/private/legacy-release.json",
    });
    expect(second.id).toBe(first.id);
    await expect(
      ensureMigrationArtifact(pool, {
        siteId,
        releaseId: "legacy-release",
        checksum: `sha256:${"d".repeat(64)}`,
        manifestChecksum,
        rendererDigest,
        snapshotRef: "/private/legacy-release.json",
      }),
    ).rejects.toBeInstanceOf(ArtifactIdentityConflict);
    expect(
      (
        await pool.query(
          'SELECT COUNT(*)::int AS count FROM "ReleaseArtifact" WHERE "siteId" = $1 AND "releaseId" = $2',
          [siteId, "legacy-release"],
        )
      ).rows[0].count,
    ).toBe(1);
  });

  it("maps an immutable artifact identity conflict to HTTP 409", async () => {
    await pool.query(
      `INSERT INTO "ReleaseArtifact"
        ("id", "siteId", "releaseId", "snapshotRef", "checksum", "assetManifestRef", "rendererDigest", "status", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'available', now())`,
      [
        randomUUID(),
        siteId,
        "artifact-conflict",
        "/private/old-artifact.json",
        checksum,
        manifestChecksum,
        rendererDigest,
      ],
    );
    const snapshot = Buffer.from('{"title":"artifact conflict"}');
    const incomingChecksum = `sha256:${createHash("sha256")
      .update(snapshot)
      .digest("hex")}`;
    const payload = {
      siteId,
      releaseId: "artifact-conflict",
      checksum: incomingChecksum,
      metadata: {
        templateId: "example",
        templateVersion: "1.0.0",
        manifestChecksum,
        imageDigest: rendererDigest,
      },
      snapshot: snapshot.toString("base64"),
    };
    const { validateReleaseInput } = await import("@gateway/contracts");
    expect(() => validateReleaseInput(payload, ["example"])).not.toThrow();
    const response = await receiveRelease(
      new Request(`http://localhost/api/v1/sites/${siteId}/releases`, {
        method: "POST",
        headers: {
          authorization: "Bearer artifact-integration-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
      siteId,
    );
    const responseBody = await response.json();
    expect(response.status, JSON.stringify(responseBody)).toBe(409);
    expect(responseBody).toEqual({
      error: "artifact_identity_conflict",
    });
  });
});
