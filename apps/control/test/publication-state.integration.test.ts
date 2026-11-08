import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readPublicationState } from "../src/publication-state";

const connectionString = process.env.GATEWAY_TEST_DATABASE_URL;
const run = connectionString ? describe : describe.skip;

run("publication state database integration", () => {
  const pool = new Pool({ connectionString });
  const workspaceId = randomUUID();
  const foreignWorkspaceId = randomUUID();
  const siteId = randomUUID();
  const foreignSiteId = randomUUID();
  const imageDigest = `sha256:${"a".repeat(64)}`;
  const snapshot = {
    schemaVersion: 1,
    workspaceId,
    siteId,
    title: "Immutable active release",
  };
  const bytes = Buffer.from(JSON.stringify(snapshot));
  let directory: string;
  let path: string;
  const request = (id = siteId) =>
    new Request(`http://localhost/api/v1/sites/${id}/publication-state`, {
      headers: { authorization: "Bearer publication-integration-secret" },
    });
  const queueObservation = (publishFailureCount15m: number) => ({
    publishFailureCount15m,
    windowMinutes: 15,
    queue: {
      sitePending: 0,
      workspacePending: 0,
      globalPending: 0,
      siteActiveLeases: 0,
      workspaceActiveLeases: 0,
      globalActiveLeases: 0,
      limits: {
        sitePending: 20,
        workspacePending: 100,
        siteActiveLeases: 1,
        workspaceActiveLeases: 2,
        globalActiveLeases: 4,
        siteStartIntervalMs: 5_000,
        retryAfterSeconds: 5,
      },
    },
  });

  beforeAll(async () => {
    vi.stubEnv("CMS_SERVICE_SECRET", "publication-integration-secret");
    vi.stubEnv("CMS_WORKSPACE_ID", workspaceId);
    directory = await mkdtemp(join(tmpdir(), "publication-state-integration-"));
    path = join(directory, "snapshot");
    await writeFile(path, bytes);
    await pool.query(
      'INSERT INTO "Workspace" ("id", "name", "updatedAt") VALUES ($1, $3, now()), ($2, $3, now())',
      [workspaceId, foreignWorkspaceId, "publication state test"],
    );
    await pool.query(
      'INSERT INTO "Site" ("id", "workspaceId", "desiredRevision", "desiredReleaseId", "updatedAt") VALUES ($1,$2,9,$3,now()),($4,$5,0,NULL,now())',
      [
        siteId,
        workspaceId,
        "pending-release",
        foreignSiteId,
        foreignWorkspaceId,
      ],
    );
    await pool.query(
      'INSERT INTO "Release" ("id","siteId","releaseId","checksum","metadata","snapshotRef") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [
        randomUUID(),
        siteId,
        "active-release",
        `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        JSON.stringify({
          imageDigest,
          templateId: "aeroframe",
          checksum: "internal-only",
        }),
        path,
      ],
    );
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await pool.query('DELETE FROM "ActiveDeployment" WHERE "siteId" = $1', [
      siteId,
    ]);
    await pool.query('DELETE FROM "Deployment" WHERE "siteId" = $1', [siteId]);
    await pool.query('DELETE FROM "Publication" WHERE "siteId" = $1', [siteId]);
    await pool.query('DELETE FROM "ReleaseArtifact" WHERE "siteId" = $1', [
      siteId,
    ]);
    await pool.query('DELETE FROM "Release" WHERE "siteId" = $1', [siteId]);
    await pool.query('DELETE FROM "Site" WHERE "id" IN ($1,$2)', [
      siteId,
      foreignSiteId,
    ]);
    await pool.query('DELETE FROM "Workspace" WHERE "id" IN ($1,$2)', [
      workspaceId,
      foreignWorkspaceId,
    ]);
    await pool.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  it("scopes the query to the authenticated workspace", async () => {
    const response = await readPublicationState(
      request(foreignSiteId),
      foreignSiteId,
      pool,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "site_not_found" });
  });
  it("returns no active state for an unactivated release", async () => {
    const response = await readPublicationState(request(), siteId, pool);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      revision: 9,
      status: "pending",
      active: null,
      observability: queueObservation(0),
    });
  });
  it("joins the active release rather than the newer desired release", async () => {
    await pool.query(
      'INSERT INTO "ActiveDeployment" ("id","siteId","releaseId","imageDigest","routeRevision") VALUES ($1,$2,$3,$4,7)',
      [randomUUID(), siteId, "active-release", imageDigest],
    );
    const response = await readPublicationState(request(), siteId, pool);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      revision: 9,
      status: "unknown",
      active: {
        releaseId: "active-release",
        imageDigest,
        routeRevision: 7,
        metadata: { imageDigest, templateId: "aeroframe" },
        snapshot,
        createdAt: expect.any(String),
      },
      observability: queueObservation(0),
    });
  });
  it("counts only failed operations inside the fifteen-minute window", async () => {
    const ids = Array.from({ length: 4 }, () => randomUUID());
    await pool.query(
      `INSERT INTO "PublishOperation"
      ("id","workspaceId","siteId","idempotencyKey","releaseId","expectedRevision","desiredRevision","status","failureCode","updatedAt")
      VALUES
        ($1,$5,$6,$7,$8,0,1,'failed','CANDIDATE_UNHEALTHY',now()-interval '1 minute'),
        ($2,$5,$6,$9,$8,0,1,'failed','ROUTE_SWITCH_FAILED',now()-interval '2 minutes'),
        ($3,$5,$6,$10,$8,0,1,'failed','WORKER_INTERNAL_ERROR',now()-interval '3 minutes'),
        ($4,$5,$6,$11,$8,0,1,'failed','CANDIDATE_UNHEALTHY',now()-interval '30 minutes')`,
      [
        ids[0],
        ids[1],
        ids[2],
        ids[3],
        workspaceId,
        siteId,
        "window-1-key",
        "active-release",
        "window-2-key",
        "window-3-key",
        "window-4-key",
      ],
    );
    try {
      const response = await readPublicationState(request(), siteId, pool);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        active: { releaseId: "active-release", routeRevision: 7 },
        observability: queueObservation(3),
      });
    } finally {
      await pool.query(
        'DELETE FROM "PublishOperation" WHERE "id" = ANY($1::uuid[])',
        [ids],
      );
    }
  });
  it("reports bounded pending and active queue capacity for the authenticated site", async () => {
    const operationId = randomUUID();
    await pool.query(
      `INSERT INTO "PublishOperation"
      ("id","workspaceId","siteId","idempotencyKey","releaseId","expectedRevision","desiredRevision","status","leaseOwner","leaseUntil","updatedAt")
      VALUES ($1,$2,$3,'queue-observation','active-release',0,1,'pending','queue-worker',now()+interval '1 minute',now())`,
      [operationId, workspaceId, siteId],
    );
    try {
      const response = await readPublicationState(request(), siteId, pool);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        observability: {
          queue: {
            sitePending: 1,
            workspacePending: 1,
            globalPending: 1,
            siteActiveLeases: 1,
            workspaceActiveLeases: 1,
            globalActiveLeases: 1,
            limits: {
              sitePending: 20,
              workspacePending: 100,
              siteActiveLeases: 1,
              workspaceActiveLeases: 2,
              globalActiveLeases: 4,
              siteStartIntervalMs: 5_000,
              retryAfterSeconds: 5,
            },
          },
        },
      });
    } finally {
      await pool.query('DELETE FROM "PublishOperation" WHERE "id" = $1', [
        operationId,
      ]);
    }
  });
  it("fails closed on changed immutable bytes", async () => {
    await writeFile(path, JSON.stringify({ ...snapshot, title: "Tampered" }));
    const response = await readPublicationState(request(), siteId, pool);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "publication_state_unavailable",
    });
  });
});
