import { request as httpRequest } from 'node:http';
import type { Pool } from 'pg';
import type { Route } from './runtime.js';

interface OwnedIdentity { siteId: string; workspaceId: string; releaseId: string; image: string }
interface ListedContainer { Id: string; Labels: Record<string, string> }
interface RetirementClient {
  list(): Promise<ListedContainer[]>;
  retire(id: string, identity: OwnedIdentity): Promise<boolean>;
}
const idPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
interface ContainerInspection {
  Id?: string; Name?: string; Mounts?: unknown[];
  Config?: { Image?: string; User?: string; Env?: string[]; Labels?: Record<string, string> };
  HostConfig?: { NetworkMode?: string; ReadonlyRootfs?: boolean; Privileged?: boolean;
    CapAdd?: string[] | null; CapDrop?: string[]; SecurityOpt?: string[];
    Memory?: number; NanoCpus?: number; PidsLimit?: number;
    PortBindings?: Record<string, { HostIp?: string; HostPort?: string }[]> };
}
const imagePattern = /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@)?sha256:[a-f0-9]{64}$/;

// Separate from the per-attempt create/start client: no arbitrary Docker requests,
// no pruning of images/networks/volumes, and every removal revalidates ownership.
export function createRetirementClient(socketPath: string): RetirementClient {
  function send(method: 'GET' | 'DELETE', path: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const request = httpRequest({ socketPath, method, path }, response => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024) request.destroy(new Error('Docker retirement response too large'));
          else chunks.push(chunk);
        });
        response.on('error', () => reject(new Error('Docker retirement response interrupted')));
        response.on('end', () => {
          if (response.statusCode === 404) { resolve(null); return; }
          if (response.statusCode !== 200 && response.statusCode !== 204) { reject(new Error('Docker retirement request failed')); return; }
          try { resolve(size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null); }
          catch { reject(new Error('Invalid Docker retirement response')); }
        });
      });
      const timer = setTimeout(() => request.destroy(new Error('Docker retirement timeout')), 1500);
      request.on('close', () => clearTimeout(timer));
      request.on('error', () => reject(new Error('Docker retirement request failed')));
      request.end();
    });
  }
  return {
    async list() {
      const data = await send('GET', `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ label: ['gateway.site-id', 'gateway.release-id'] }))}`);
      if (!Array.isArray(data) || data.some(item => !item || !idPattern.test(item.Id) || !item.Labels || typeof item.Labels !== 'object')) throw new Error('Invalid Docker retirement listing');
      return data;
    },
    async retire(id, identity) {
      if (!idPattern.test(id)) throw new Error('Invalid container identity');
      if (!uuidPattern.test(identity.siteId) || !uuidPattern.test(identity.workspaceId) ||
          !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(identity.releaseId) || !imagePattern.test(identity.image)) return false;
      const data = await send('GET', `/containers/${id}/json`) as ContainerInspection | null;
      if (data === null) return true;
      const config = data.Config, host = data.HostConfig;
      const env = config?.Env;
      const bindings = host?.PortBindings;
      const ports = bindings?.['3000/tcp'];
      if (data.Id !== id || typeof data.Name !== 'string' || !data.Name.startsWith(`/gateway-${identity.siteId}-`) || !uuidPattern.test(data.Name.slice(`/gateway-${identity.siteId}-`.length)) ||
          !Array.isArray(data.Mounts) || data.Mounts.length !== 0 || config?.Image !== identity.image || config?.User !== '10001:10001' ||
          config?.Labels?.['gateway.site-id'] !== identity.siteId || config?.Labels?.['gateway.release-id'] !== identity.releaseId ||
          !Array.isArray(env) || ![`SITE_ID=${identity.siteId}`, `RELEASE_ID=${identity.releaseId}`, `NUXT_WORKSPACE_ID=${identity.workspaceId}`, `NUXT_SITE_ID=${identity.siteId}`].every(value => env.includes(value)) ||
          host?.NetworkMode !== 'gateway-sites' || host?.ReadonlyRootfs !== true || host?.Privileged !== false ||
          (host?.CapAdd != null && (!Array.isArray(host.CapAdd) || host.CapAdd.length !== 0)) ||
          !Array.isArray(host?.CapDrop) || host.CapDrop.length !== 1 || host.CapDrop[0] !== 'ALL' ||
          !Array.isArray(host?.SecurityOpt) || host.SecurityOpt.length !== 1 || host.SecurityOpt[0] !== 'no-new-privileges:true' ||
          host?.Memory !== 536870912 || host?.NanoCpus !== 500000000 || host?.PidsLimit !== 128 ||
          !bindings || Object.keys(bindings).length !== 1 || !Array.isArray(ports) || ports.length !== 1 ||
          ports[0]?.HostIp !== '127.0.0.1' || !/^[1-9][0-9]{3,4}$/.test(ports[0]?.HostPort ?? '') || Number(ports[0].HostPort) < 1024 || Number(ports[0].HostPort) > 65535) return false;
      await send('DELETE', `/containers/${id}?force=true`);
      return true;
    },
  };
}

export async function collectRetiredContainers(pool: Pool, routes: readonly Route[], docker: RetirementClient) {
  const result = { removed: 0, failed: 0 };
  const containers = await docker.list();
  const protectedIds = new Set(routes.map(route => route.containerId));
  const siteIds = [...new Set(containers.map(item => item.Labels['gateway.site-id']).filter(id => uuidPattern.test(id)))];
  let budget = 10; // Bound Docker work per sweep; residuals are discovered next time.
  for (const siteId of siteIds) {
    if (budget <= 0) break;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '100ms'");
      // submitPublish locks this row before inserting new intent. Holding it until
      // deletion completes closes the check/delete race. Existing pending attempts
      // (even expired ones) keep every candidate until deployment reconciliation.
      const site = await client.query<{ workspaceId: string }>('SELECT "workspaceId" FROM "Site" WHERE "id" = $1 FOR UPDATE', [siteId]);
      if (!site.rowCount) continue;
      const pending = await client.query('SELECT 1 FROM "PublishOperation" WHERE "siteId" = $1 AND "status" = \'pending\' LIMIT 1', [siteId]);
      if (pending.rowCount) continue;
      const active = await client.query<{ releaseId: string; routeRevision: number }>('SELECT "releaseId", "routeRevision" FROM "ActiveDeployment" WHERE "siteId" = $1', [siteId]);
      const siteRoutes = routes.filter(route => route.siteId === siteId);
      if (active.rowCount ? !siteRoutes.some(route => route.releaseId === active.rows[0].releaseId && route.revision === active.rows[0].routeRevision && idPattern.test(route.containerId ?? '')) : siteRoutes.length > 0) continue;
      const releases = await client.query<{ releaseId: string; image: string }>(`SELECT release."releaseId",
          CASE WHEN pin."imageRepository" IS NULL THEN pin."imageDigest" ELSE pin."imageRepository" || '@' || pin."imageDigest" END AS image
        FROM "Release" release JOIN "TemplatePin" pin ON pin."siteId" = release."siteId"
          AND pin."templateId" = release."metadata"->>'templateId' AND pin."version" = release."metadata"->>'templateVersion'
          AND pin."imageDigest" = release."metadata"->>'imageDigest'
        WHERE release."siteId" = $1 AND release."snapshotRef" IS NOT NULL`, [siteId]);
      for (const container of containers) {
        if (budget <= 0) break;
        if (container.Labels['gateway.site-id'] !== siteId || protectedIds.has(container.Id)) continue;
        const release = releases.rows.find(row => row.releaseId === container.Labels['gateway.release-id']);
        if (!release) continue;
        budget--;
        try {
          if (await docker.retire(container.Id, { siteId, workspaceId: site.rows[0].workspaceId, releaseId: release.releaseId, image: release.image })) result.removed++;
        } catch { result.failed++; }
      }
      await client.query('COMMIT');
    } catch { result.failed++; }
    finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
  }
  return result;
}
