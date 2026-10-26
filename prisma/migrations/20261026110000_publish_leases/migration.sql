ALTER TABLE "Site" ADD COLUMN "desiredRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Site" ADD COLUMN "desiredReleaseId" TEXT;

ALTER TABLE "PublishOperation" ADD COLUMN "expectedRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PublishOperation" ALTER COLUMN "expectedRevision" DROP DEFAULT;
ALTER TABLE "PublishOperation" ADD COLUMN "desiredRevision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "PublishOperation" ALTER COLUMN "desiredRevision" DROP DEFAULT;
ALTER TABLE "PublishOperation" ADD COLUMN "leaseOwner" TEXT;
ALTER TABLE "PublishOperation" ADD COLUMN "leaseUntil" TIMESTAMPTZ(6);
ALTER TABLE "PublishOperation" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "PublishOperation_claim_idx" ON "PublishOperation"("status", "leaseUntil", "createdAt");
