ALTER TABLE "Domain"
  ADD COLUMN "ownershipStatus" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "dnsStatus" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "lastCheckedAt" TIMESTAMPTZ(6);

UPDATE "Domain"
SET "ownershipStatus" = CASE WHEN "status" IN ('verified', 'active') THEN 'verified' ELSE 'pending' END,
    "dnsStatus" = CASE WHEN "status" = 'active' THEN 'ready' ELSE 'pending' END,
    "enabled" = "status" <> 'disabled';

WITH ranked AS (
  SELECT "id", row_number() OVER (PARTITION BY "siteId" ORDER BY "createdAt", "id") AS rank
  FROM "Domain"
  WHERE "status" = 'active'
)
UPDATE "Domain" domain
SET "isPrimary" = ranked.rank = 1
FROM ranked
WHERE ranked."id" = domain."id";

CREATE UNIQUE INDEX "Domain_siteId_primary_key" ON "Domain"("siteId") WHERE "isPrimary" = true;
