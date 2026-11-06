CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Split immutable release artifacts and mutable publication/deployment state from
-- the legacy Release and ActiveDeployment tables. The legacy tables remain in
-- place during the compatibility window and are populated by the application.

CREATE TABLE "ReleaseArtifact" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "releaseId" TEXT NOT NULL,
    "snapshotRef" TEXT,
    "checksum" TEXT NOT NULL,
    "assetManifestRef" TEXT,
    "rendererDigest" TEXT,
    "status" TEXT NOT NULL DEFAULT 'available',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "ReleaseArtifact_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Publication" (
    "siteId" UUID NOT NULL,
    "desiredReleaseId" TEXT,
    "activeReleaseId" TEXT,
    "desiredRevision" INTEGER NOT NULL DEFAULT 0,
    "routeRevision" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "Publication_pkey" PRIMARY KEY ("siteId")
);

CREATE TABLE "Deployment" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "releaseId" TEXT NOT NULL,
    "artifactId" UUID NOT NULL,
    "imageDigest" TEXT NOT NULL,
    "host" TEXT,
    "healthStatus" TEXT NOT NULL DEFAULT 'unknown',
    "routeRevision" INTEGER NOT NULL DEFAULT 0,
    "activatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReleaseArtifact_siteId_releaseId_key" ON "ReleaseArtifact"("siteId", "releaseId");
CREATE INDEX "ReleaseArtifact_siteId_status_idx" ON "ReleaseArtifact"("siteId", "status");
CREATE INDEX "Publication_status_updatedAt_idx" ON "Publication"("status", "updatedAt");
CREATE INDEX "Deployment_siteId_activatedAt_idx" ON "Deployment"("siteId", "activatedAt");
CREATE INDEX "Deployment_artifactId_idx" ON "Deployment"("artifactId");
ALTER TABLE "ReleaseArtifact" ADD CONSTRAINT "ReleaseArtifact_status_check"
  CHECK ("status" IN ('available', 'invalid'));
ALTER TABLE "Publication" ADD CONSTRAINT "Publication_status_check"
  CHECK ("status" IN ('pending', 'healthy', 'active', 'failed', 'degraded', 'unknown'));
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_healthStatus_check"
  CHECK ("healthStatus" IN ('healthy', 'unhealthy', 'degraded', 'unknown'));

ALTER TABLE "ReleaseArtifact" ADD CONSTRAINT "ReleaseArtifact_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReleaseArtifact" ADD CONSTRAINT "ReleaseArtifact_siteId_releaseId_fkey"
  FOREIGN KEY ("siteId", "releaseId") REFERENCES "Release"("siteId", "releaseId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Publication" ADD CONSTRAINT "Publication_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_artifactId_fkey"
  FOREIGN KEY ("artifactId") REFERENCES "ReleaseArtifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Existing releases become immutable artifacts. The metadata fields are only
-- used as a migration source; subsequent writes use explicit artifact columns.
INSERT INTO "ReleaseArtifact" ("id", "siteId", "releaseId", "snapshotRef", "checksum", "assetManifestRef", "rendererDigest", "status", "createdAt", "updatedAt")
SELECT gen_random_uuid(), release."siteId", release."releaseId", release."snapshotRef", release."checksum",
  CASE WHEN jsonb_typeof(release."metadata"->'manifestChecksum') = 'string' THEN release."metadata"->>'manifestChecksum' END,
  CASE WHEN jsonb_typeof(release."metadata"->'imageDigest') = 'string' THEN release."metadata"->>'imageDigest' END,
  CASE WHEN release."snapshotRef" IS NULL THEN 'invalid' ELSE 'available' END,
  release."createdAt", release."createdAt"
FROM "Release" release;

INSERT INTO "Publication" ("siteId", "desiredReleaseId", "activeReleaseId", "desiredRevision", "routeRevision", "status", "createdAt", "updatedAt")
SELECT site."id", site."desiredReleaseId", active."releaseId", site."desiredRevision", COALESCE(active."routeRevision", 0),
  CASE WHEN active."releaseId" IS NOT NULL AND active."releaseId" = site."desiredReleaseId" THEN 'active'
       WHEN active."releaseId" IS NOT NULL THEN 'degraded'
       ELSE 'pending' END,
  site."createdAt", GREATEST(site."updatedAt", COALESCE(active."activatedAt", site."updatedAt"))
FROM "Site" site
LEFT JOIN "ActiveDeployment" active ON active."siteId" = site."id";

INSERT INTO "Deployment" ("id", "siteId", "releaseId", "artifactId", "imageDigest", "healthStatus", "routeRevision", "activatedAt")
SELECT active."id", active."siteId", active."releaseId", artifact."id", active."imageDigest", 'healthy', active."routeRevision", active."activatedAt"
FROM "ActiveDeployment" active
JOIN "ReleaseArtifact" artifact ON artifact."siteId" = active."siteId" AND artifact."releaseId" = active."releaseId";
