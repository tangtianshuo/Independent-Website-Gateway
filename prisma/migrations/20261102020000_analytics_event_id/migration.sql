ALTER TABLE "AnalyticsEvent" ADD COLUMN "eventId" UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX "AnalyticsEvent_siteId_eventId_key" ON "AnalyticsEvent"("siteId", "eventId");
