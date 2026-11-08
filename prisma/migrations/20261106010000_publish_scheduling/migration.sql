ALTER TABLE "Site"
  ADD COLUMN "lastPublishStartedAt" TIMESTAMPTZ(6);

ALTER TABLE "PublishOperation"
  ADD COLUMN "lastFailureCode" TEXT,
  ADD COLUMN "nextAttemptAt" TIMESTAMPTZ(6);

CREATE INDEX "PublishOperation_retry_idx"
  ON "PublishOperation" ("status", "nextAttemptAt");
