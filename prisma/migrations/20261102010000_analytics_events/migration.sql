CREATE TABLE "AnalyticsEvent" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "siteId" UUID NOT NULL,
  "releaseId" TEXT,
  "eventType" TEXT NOT NULL DEFAULT 'page_view',
  "path" TEXT NOT NULL,
  "referrer" TEXT,
  "device" TEXT,
  "visitorHash" TEXT,
  "sessionHash" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AnalyticsEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AnalyticsEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "AnalyticsEvent_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "AnalyticsEvent_siteId_createdAt_idx" ON "AnalyticsEvent"("siteId", "createdAt");
CREATE INDEX "AnalyticsEvent_siteId_path_createdAt_idx" ON "AnalyticsEvent"("siteId", "path", "createdAt");
CREATE INDEX "AnalyticsEvent_siteId_eventType_createdAt_idx" ON "AnalyticsEvent"("siteId", "eventType", "createdAt");
