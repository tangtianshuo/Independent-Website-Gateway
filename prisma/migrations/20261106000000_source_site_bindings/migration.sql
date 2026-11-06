CREATE TABLE "SourceWorkspaceBinding" (
    "instanceId" TEXT NOT NULL,
    "cmsWorkspaceId" TEXT NOT NULL,
    "workspaceId" UUID NOT NULL,
    CONSTRAINT "SourceWorkspaceBinding_pkey" PRIMARY KEY ("instanceId", "cmsWorkspaceId"),
    CONSTRAINT "SourceWorkspaceBinding_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SourceWorkspaceBinding_instanceId_cmsWorkspaceId_workspaceId_key" ON "SourceWorkspaceBinding"("instanceId", "cmsWorkspaceId", "workspaceId");
CREATE UNIQUE INDEX "Domain_siteId_id_key" ON "Domain"("siteId", "id");
CREATE TABLE "SourceSiteBinding" (
    "instanceId" TEXT NOT NULL,
    "cmsWorkspaceId" TEXT NOT NULL,
    "cmsSiteId" TEXT NOT NULL,
    "workspaceId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "requestKey" TEXT NOT NULL,
    "defaultDomainId" UUID NOT NULL,
    CONSTRAINT "SourceSiteBinding_defaultDomain_fkey" FOREIGN KEY ("siteId", "defaultDomainId") REFERENCES "Domain"("siteId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SourceSiteBinding_pkey" PRIMARY KEY ("instanceId", "cmsWorkspaceId", "cmsSiteId"),
    CONSTRAINT "SourceSiteBinding_sourceWorkspace_fkey" FOREIGN KEY ("instanceId", "cmsWorkspaceId", "workspaceId") REFERENCES "SourceWorkspaceBinding"("instanceId", "cmsWorkspaceId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SourceSiteBinding_site_fkey" FOREIGN KEY ("workspaceId", "siteId") REFERENCES "Site"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SourceSiteBinding_siteId_key" ON "SourceSiteBinding"("siteId");
CREATE UNIQUE INDEX "SourceSiteBinding_instanceId_requestKey_key" ON "SourceSiteBinding"("instanceId", "requestKey");
CREATE UNIQUE INDEX "SourceSiteBinding_workspaceId_siteId_key" ON "SourceSiteBinding"("workspaceId", "siteId");
