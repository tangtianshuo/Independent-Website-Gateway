import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Pool } from "pg";
import {
  readPublishFailureCount15m,
  readPublishQueueObservation,
} from "../../../packages/worker/src/observability";
import { readPublishLimits } from "../../../packages/worker/src/claim";
import { readPublishQuota } from "./publish";
import {
  authenticateSiteService,
  serviceScopeErrorResponse,
} from "./service-scope";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^sha256:[a-f0-9]{64}$/;
const maxSnapshotBytes = 10 * 1024 * 1024;
const publicMetadataKeys = [
  "templateId",
  "templateVersion",
  "manifestChecksum",
  "imageDigest",
  "imageRepository",
  "sourceCommit",
] as const;
const publicationStatuses = new Set([
  "pending",
  "healthy",
  "active",
  "failed",
  "degraded",
  "unknown",
]);

interface PublicationRow {
  desiredRevision: number;
  publicationStatus?: string | null;
  releaseId: string | null;
  imageDigest: string | null;
  routeRevision: number | null;
  metadata: unknown;
  checksum: string | null;
  snapshotRef: string | null;
  artifactId?: string | null;
  artifactChecksum?: string | null;
  assetManifestRef?: string | null;
  rendererDigest?: string | null;
  artifactStatus?: string | null;
  deploymentHealthStatus?: string | null;
  createdAt: Date | null;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readSnapshot(path: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  // Read at most one byte beyond the limit, even if a file grows after it was opened.
  for await (const chunk of createReadStream(path, { end: maxSnapshotBytes })) {
    const bytes = chunk as Buffer;
    length += bytes.length;
    if (length > maxSnapshotBytes) throw new Error("Invalid snapshot size");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export async function readPublicationState(
  request: Request,
  siteId: string,
  pool: Pool,
): Promise<Response> {
  let principal;
  try {
    principal = await authenticateSiteService(request, siteId, pool);
  } catch (error) {
    return serviceScopeErrorResponse(error);
  }
  if (!uuid.test(siteId) || !uuid.test(principal.workspaceId))
    return json({ error: "invalid_request" }, 400);

  try {
    // One statement reads a consistent desired revision and authoritative active tuple.
    const result = await pool.query<PublicationRow>(
      `
      SELECT COALESCE(publication."desiredRevision", site."desiredRevision") AS "desiredRevision",
        COALESCE(publication."status", CASE WHEN active."releaseId" IS NULL THEN 'pending' ELSE 'unknown' END) AS "publicationStatus",
        COALESCE(publication."activeReleaseId", active."releaseId") AS "releaseId",
        COALESCE(deployment."imageDigest", active."imageDigest") AS "imageDigest",
        COALESCE(publication."routeRevision", deployment."routeRevision", active."routeRevision") AS "routeRevision",
        saved."metadata", COALESCE(artifact."checksum", saved."checksum") AS "checksum",
        COALESCE(artifact."snapshotRef", saved."snapshotRef") AS "snapshotRef",
        artifact."id" AS "artifactId", artifact."checksum" AS "artifactChecksum",
        artifact."assetManifestRef", artifact."rendererDigest", artifact."status" AS "artifactStatus",
        deployment."healthStatus" AS "deploymentHealthStatus",
        COALESCE(deployment."activatedAt", active."activatedAt", artifact."createdAt", saved."createdAt") AS "createdAt"
      FROM "Site" site
      LEFT JOIN "Publication" publication ON publication."siteId" = site."id"
      LEFT JOIN "ActiveDeployment" active ON active."siteId" = site."id"
      LEFT JOIN "Deployment" deployment ON deployment."id" = active."id"
      LEFT JOIN "Release" saved ON saved."siteId" = site."id" AND saved."releaseId" = COALESCE(publication."activeReleaseId", active."releaseId")
      LEFT JOIN "ReleaseArtifact" artifact ON artifact."siteId" = site."id" AND artifact."releaseId" = COALESCE(publication."activeReleaseId", active."releaseId")
      WHERE site."id" = $1 AND site."workspaceId" = $2`,
      [siteId, principal.workspaceId],
    );
    if (!result.rowCount) return json({ error: "site_not_found" }, 404);
    const row = result.rows[0];
    if (!Number.isSafeInteger(row.desiredRevision) || row.desiredRevision < 0)
      throw new Error("Invalid revision");
    const [publishFailureCount15m, queueCounts] = await Promise.all([
      readPublishFailureCount15m(pool, siteId),
      readPublishQueueObservation(pool, siteId, principal.workspaceId),
    ]);
    const activeLimits = readPublishLimits();
    const pendingLimits = readPublishQuota();
    const observability = {
      publishFailureCount15m,
      windowMinutes: 15,
      queue: {
        ...queueCounts,
        limits: {
          sitePending: pendingLimits.site,
          workspacePending: pendingLimits.workspace,
          siteActiveLeases: activeLimits.maxSiteLeases,
          workspaceActiveLeases: activeLimits.maxWorkspaceLeases,
          globalActiveLeases: activeLimits.maxGlobalLeases,
          siteStartIntervalMs: activeLimits.siteStartIntervalMs,
          retryAfterSeconds: pendingLimits.retryAfter,
        },
      },
    };
    const status =
      typeof row.publicationStatus === "string" &&
      publicationStatuses.has(row.publicationStatus)
        ? row.publicationStatus
        : row.deploymentHealthStatus === "healthy"
          ? "healthy"
          : undefined;
    if (row.releaseId === null)
      return json({
        revision: row.desiredRevision,
        ...(status ? { status } : {}),
        active: null,
        observability,
      });
    if (
      !row.releaseId ||
      !row.imageDigest ||
      !digest.test(row.imageDigest) ||
      !Number.isSafeInteger(row.routeRevision) ||
      row.routeRevision! < 0 ||
      !row.snapshotRef ||
      !row.checksum ||
      !digest.test(row.checksum) ||
      !object(row.metadata) ||
      !row.createdAt ||
      !Number.isFinite(row.createdAt.getTime())
    )
      throw new Error("Invalid active release");
    if (
      row.metadata.imageDigest !== undefined &&
      row.metadata.imageDigest !== null &&
      row.metadata.imageDigest !== "" &&
      row.metadata.imageDigest !== row.imageDigest
    )
      throw new Error("Inconsistent image pin");
    const bytes = await readSnapshot(row.snapshotRef);
    if (
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` !==
      row.checksum
    )
      throw new Error("Invalid snapshot checksum");
    const snapshot: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      !object(snapshot) ||
      snapshot.schemaVersion !== 1 ||
      snapshot.workspaceId !== principal.workspaceId ||
      snapshot.siteId !== siteId
    )
      throw new Error("Invalid snapshot identity");
    const storedMetadata = row.metadata;
    const metadata = Object.fromEntries(
      publicMetadataKeys.flatMap((key) =>
        typeof storedMetadata[key] === "string"
          ? [[key, storedMetadata[key]]]
          : [],
      ),
    );
    const artifact =
      row.artifactId ||
      row.artifactChecksum ||
      row.assetManifestRef ||
      row.rendererDigest ||
      row.artifactStatus
        ? {
            id: row.artifactId ?? null,
            checksum: row.artifactChecksum ?? row.checksum,
            ...(row.assetManifestRef
              ? { assetManifestRef: row.assetManifestRef }
              : {}),
            ...(row.rendererDigest
              ? { rendererDigest: row.rendererDigest }
              : {}),
            status: row.artifactStatus ?? "unknown",
          }
        : undefined;
    return json({
      revision: row.desiredRevision,
      ...(status ? { status } : {}),
      active: {
        releaseId: row.releaseId,
        imageDigest: row.imageDigest,
        routeRevision: row.routeRevision,
        metadata,
        snapshot,
        createdAt: row.createdAt.toISOString(),
        ...(artifact ? { artifact } : {}),
      },
      observability,
    });
  } catch {
    return json({ error: "publication_state_unavailable" }, 503);
  }
}
