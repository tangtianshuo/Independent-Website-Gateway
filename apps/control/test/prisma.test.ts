import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(process.cwd(), '../..');
const schema = readFileSync(resolve(root, 'prisma/schema.prisma'), 'utf8');
const migration = readFileSync(resolve(root, 'prisma/migrations/20261026100000_gateway_core/migration.sql'), 'utf8');
const artifactMigration = readFileSync(resolve(root, 'prisma/migrations/20261031100000_release_artifacts/migration.sql'), 'utf8');
const domainControlMigration = readFileSync(resolve(root, 'prisma/migrations/20261102030000_domain_control_plane/migration.sql'), 'utf8');

describe('database integrity constraints', () => {
  it('binds every publish operation to a site in the same workspace', () => {
    expect(schema).toContain('@@unique([workspaceId, id])');
    expect(schema).toContain('fields: [workspaceId, siteId], references: [workspaceId, id]');
    expect(migration).toContain('FOREIGN KEY ("workspaceId", "siteId") REFERENCES "Site"("workspaceId", "id")');
  });

  it('prevents deleting workspaces and sites while dependent history exists', () => {
    expect(schema).not.toContain('onDelete: Cascade');
    expect(migration).not.toContain('ON DELETE CASCADE');
  });

  it('defines the split artifact and publication state model with a backfill path', () => {
    expect(schema).toContain('model ReleaseArtifact');
    expect(schema).toContain('model Publication');
    expect(schema).toContain('model Deployment');
    expect(schema).toContain('artifactId');
    expect(artifactMigration).toContain('CREATE TABLE "ReleaseArtifact"');
    expect(artifactMigration).toContain('INSERT INTO "ReleaseArtifact"');
    expect(artifactMigration).toContain('INSERT INTO "Publication"');
    expect(artifactMigration).toContain('INSERT INTO "Deployment"');
  });

  it('stores domain ownership, certificate, primary, and route control state in Gateway', () => {
    expect(schema).toContain('ownershipStatus');
    expect(schema).toContain('dnsStatus');
    expect(schema).toContain('isPrimary');
    expect(domainControlMigration).toContain('CREATE UNIQUE INDEX "Domain_siteId_primary_key"');
    expect(domainControlMigration).toContain('row_number() OVER (PARTITION BY "siteId"');
  });
});
