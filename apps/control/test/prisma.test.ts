import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(process.cwd(), '../..');
const schema = readFileSync(resolve(root, 'prisma/schema.prisma'), 'utf8');
const migration = readFileSync(resolve(root, 'prisma/migrations/20261026100000_gateway_core/migration.sql'), 'utf8');

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
});
