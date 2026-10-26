-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Workspace" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Site" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemplatePin" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "templateId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "imageDigest" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "TemplatePin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Release" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "releaseId" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "snapshotRef" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Release_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Domain" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "hostname" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "certificateStatus" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "Domain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishOperation" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "failureCode" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "PublishOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActiveDeployment" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "releaseId" TEXT NOT NULL,
    "imageDigest" TEXT NOT NULL,
    "routeRevision" INTEGER NOT NULL DEFAULT 0,
    "activatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ActiveDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Site_workspaceId_id_key" ON "Site"("workspaceId", "id");
CREATE INDEX "Site_workspaceId_idx" ON "Site"("workspaceId");
CREATE UNIQUE INDEX "TemplatePin_siteId_templateId_key" ON "TemplatePin"("siteId", "templateId");
CREATE UNIQUE INDEX "Release_siteId_releaseId_key" ON "Release"("siteId", "releaseId");
CREATE UNIQUE INDEX "Domain_hostname_key" ON "Domain"("hostname");
CREATE INDEX "PublishOperation_siteId_status_idx" ON "PublishOperation"("siteId", "status");
CREATE UNIQUE INDEX "PublishOperation_siteId_idempotencyKey_key" ON "PublishOperation"("siteId", "idempotencyKey");
CREATE UNIQUE INDEX "ActiveDeployment_siteId_key" ON "ActiveDeployment"("siteId");

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TemplatePin" ADD CONSTRAINT "TemplatePin_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Release" ADD CONSTRAINT "Release_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PublishOperation" ADD CONSTRAINT "PublishOperation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PublishOperation" ADD CONSTRAINT "PublishOperation_workspaceId_siteId_fkey" FOREIGN KEY ("workspaceId", "siteId") REFERENCES "Site"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ActiveDeployment" ADD CONSTRAINT "ActiveDeployment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
