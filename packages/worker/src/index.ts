import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { Pool } from 'pg';
import { claimPublishOperation } from './claim.js';
import { deployCandidate } from './deployment.js';
import { createDockerEngineClient } from './docker-client.js';
import { createDockerCandidateAdapter } from './docker.js';
import { failPublishOperation, finalizeAfterRouteVerification, persistCandidateCredential } from './operations.js';
import { checkCandidate, createLocalRouter, type Route } from './runtime.js';

export const workerStatus = 'running' as const;
const digestPattern = /^sha256:[a-f0-9]{64}$/;

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = address && typeof address !== 'string' ? address.port : 0;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

function inspectRoute(socketPath: string, route: Route): Promise<boolean> {
  if (!route.containerId || !/^[a-zA-Z0-9_-]{1,128}$/.test(route.containerId)) return Promise.resolve(false);
  return new Promise(resolve => {
    const request = httpRequest({ socketPath, path: `/containers/${route.containerId}/json`, method: 'GET', timeout: 3000 }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size < 1024 * 1024) chunks.push(chunk); else request.destroy(); });
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) return resolve(false);
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const binding = data.NetworkSettings?.Ports?.['3000/tcp'];
          resolve(data.Id === route.containerId && data.State?.Running === true &&
            data.Config?.Labels?.['gateway.site-id'] === route.siteId &&
            data.Config?.Labels?.['gateway.release-id'] === route.releaseId &&
            Array.isArray(binding) && binding.length === 1 && binding[0].HostIp === '127.0.0.1' &&
            binding[0].HostPort === String(route.port));
        } catch { resolve(false); }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
    request.end();
  });
}

export async function runWorker() {
  const databaseUrl = process.env.DATABASE_URL;
  const digest = process.env.GATEWAY_APPROVED_IMAGE_DIGEST;
  const gatewayUrl = process.env.GATEWAY_CONTROL_URL;
  const proxyPort = Number(process.env.GATEWAY_PROXY_PORT ?? 8080);
  if (!databaseUrl || !digest || !digestPattern.test(digest) ||
      !gatewayUrl || !/^http:\/\/host\.docker\.internal:[1-9][0-9]{0,4}$/.test(gatewayUrl) ||
      !Number.isSafeInteger(proxyPort) || proxyPort < 1024 || proxyPort > 65535) throw new Error('Invalid worker configuration');
  const pool = new Pool({ connectionString: databaseUrl });
  const image = { repository: 'local', digest };
  const socketPath = process.env.DOCKER_SOCKET_PATH ?? (process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock');
  const docker = createDockerEngineClient({ socketPath, approvedImages: [digest] });
  const adapter = createDockerCandidateAdapter(docker, { network: 'gateway-sites', images: [image] });
  const router = createLocalRouter(process.env.GATEWAY_ROUTE_STATE_PATH ?? './gateway-routes.json', route => inspectRoute(socketPath, route));
  const workerId = randomUUID();
  await pool.query('SELECT 1');
  await router.recover(async () => {
    const active = await pool.query<{ siteId: string; releaseId: string; routeRevision: number }>(
      `SELECT deployment."siteId", deployment."releaseId", deployment."routeRevision" FROM "ActiveDeployment" deployment
       JOIN "Site" site ON site."id" = deployment."siteId"`);
    return active.rows;
  }, route => inspectRoute(socketPath, route));
  await router.listen(proxyPort);
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    while (!stopping) {
      try {
        const claim = await claimPublishOperation(pool, workerId, 180);
        if (claim) {
          const selected = await pool.query<{ imageDigest: string }>(`
            SELECT pin."imageDigest" FROM "Release" release JOIN "TemplatePin" pin
              ON pin."siteId" = release."siteId" AND pin."templateId" = release."metadata"->>'templateId'
              AND pin."version" = release."metadata"->>'templateVersion'
              AND pin."imageDigest" = release."metadata"->>'imageDigest'
            WHERE release."siteId" = $1 AND release."releaseId" = $2 AND release."snapshotRef" IS NOT NULL
              AND pin."imageDigest" = $3`, [claim.siteId, claim.releaseId, digest]);
          if (!selected.rowCount) {
            await failPublishOperation(pool, { operationId: claim.id, workerId, attempts: claim.attempts, leaseUntil: claim.leaseUntil, failureCode: 'CANDIDATE_CREATE_FAILED' });
            continue;
          }
          const credential = randomBytes(32).toString('hex');
          if (!await persistCandidateCredential(pool, { operationId: claim.id, workerId, attempts: claim.attempts, leaseUntil: claim.leaseUntil, credential })) continue;
          let candidatePort = 0;
          const containerPorts = new Map<string, number>();
          try {
            await deployCandidate(claim, image, {
              getRepresentativeHost: async siteId => {
                const row = await pool.query<{ hostname: string }>(`SELECT "hostname" FROM "Domain" WHERE "siteId" = $1 AND "status" = 'verified' ORDER BY "hostname" LIMIT 1`, [siteId]);
                return row.rows[0]?.hostname ?? '';
              },
              readRoute: siteId => router.readRoute(siteId),
              readDeploymentState: async operationId => {
                const state = await pool.query(`SELECT operation."status", operation."desiredRevision", operation."leaseOwner",
                  operation."leaseUntil", operation."attempts", deployment."releaseId", deployment."imageDigest", deployment."routeRevision"
                  FROM "PublishOperation" operation LEFT JOIN "ActiveDeployment" deployment ON deployment."siteId" = operation."siteId"
                  WHERE operation."id" = $1`, [operationId]);
                const row = state.rows[0];
                return row ? { status: row.status, desiredRevision: row.desiredRevision, leaseOwner: row.leaseOwner,
                  leaseUntil: row.leaseUntil, attempts: row.attempts,
                  active: row.releaseId ? { releaseId: row.releaseId, imageDigest: row.imageDigest, routeRevision: row.routeRevision } : null } : null;
              },
              startCandidate: async candidate => {
                candidatePort = await reservePort();
                const containerId = await adapter.startCandidate({ ...candidate, workspaceId: claim.workspaceId, credential, gatewayUrl, hostPort: candidatePort });
                containerPorts.set(containerId, candidatePort);
                return containerId;
              },
              removeCandidate: async containerId => {
                await docker.request({ method: 'DELETE', path: `/containers/${containerId}?force=true` });
                containerPorts.delete(containerId);
              },
              waitHealthy: async containerId => {
                const port = containerPorts.get(containerId);
                if (!port) return false;
                for (let attempt = 0; attempt < 25 && Date.now() < claim.leaseUntil.getTime() - 5000; attempt++) {
                  if (await checkCandidate(port, 'localhost')) return true;
                  await new Promise(resolve => setTimeout(resolve, 1000));
                }
                return false;
              },
              checkRepresentativeHost: (containerId, host) => checkCandidate(containerPorts.get(containerId)!, host, '/'),
              applyRoute: (siteId, revision, containerId, host, token) => router.applyRoute(siteId, revision, containerPorts.get(containerId)!, host, token, containerId, claim.releaseId),
              verifyRoute: (siteId, revision, host) => router.verifyRoute(siteId, revision, host),
              restoreRoute: (siteId, token, previous) => router.restoreRoute(siteId, token, previous),
              finalizeAfterRouteVerification: input => finalizeAfterRouteVerification(pool, input),
              failPublishOperation: input => failPublishOperation(pool, input),
            });
          } catch (error) { console.error('Publish operation failed:', error instanceof Error ? error.message : 'unknown'); }
        } else await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        console.error('Worker cycle failed:', error instanceof Error ? error.message : 'unknown');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  } finally { await router.close(); await pool.end(); }
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  runWorker().catch(error => { console.error(error instanceof Error ? error.message : 'Worker failed'); process.exitCode = 1; });
}
