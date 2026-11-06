ALTER TABLE "Domain" ADD COLUMN "verificationTokenHash" TEXT, ADD COLUMN "verificationExpiresAt" TIMESTAMPTZ, ADD COLUMN "lastError" TEXT;
CREATE TABLE "DomainChange" (
  "siteId" UUID PRIMARY KEY REFERENCES "Site"("id") ON DELETE RESTRICT,
  "id" UUID NOT NULL UNIQUE,
  "domainId" UUID NOT NULL,
  "operation" TEXT NOT NULL CHECK ("operation" IN ('primary','state','remove')),
  "enabled" BOOLEAN,
  "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending','succeeded','failed')),
  "error" TEXT,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
