CREATE TABLE "Lead" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "siteId" UUID NOT NULL,
  "source" TEXT NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "name" TEXT,
  "email" TEXT,
  "phone" TEXT,
  "message" TEXT,
  "fields" JSONB NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "ipHash" TEXT,
  "status" TEXT NOT NULL DEFAULT 'new',
  "assignedTo" TEXT,
  "notes" TEXT,
  "notificationStatus" TEXT NOT NULL DEFAULT 'pending',
  "notificationError" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Lead_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Lead_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Lead_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Lead_siteId_dedupeKey_key" ON "Lead"("siteId", "dedupeKey");
CREATE INDEX "Lead_siteId_createdAt_idx" ON "Lead"("siteId", "createdAt");
CREATE INDEX "Lead_siteId_status_createdAt_idx" ON "Lead"("siteId", "status", "createdAt");
