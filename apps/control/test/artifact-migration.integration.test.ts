import { randomUUID } from "node:crypto";
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

  beforeAll(async () => {
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
});
