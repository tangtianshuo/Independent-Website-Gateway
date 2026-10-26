import { randomUUID } from 'node:crypto';

interface ImageIdentity { repository: string; digest: string }
export interface Candidate {
  siteId: string;
  releaseId: string;
  image: ImageIdentity;
  workspaceId: string;
  credential: string;
  gatewayUrl: string;
  hostPort: number;
}
interface DockerRequest { method: 'POST' | 'DELETE'; path: string; body?: Record<string, unknown> }
interface DockerClient { request(request: DockerRequest): Promise<{ Id: string }> }
interface DockerConfig { network: string; images: readonly ImageIdentity[] }

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const repositoryPattern = /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*)(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/;
const sitePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const releasePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/;
const networkPattern = /^gateway-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const gatewayPattern = /^http:\/\/(?:host\.docker\.internal|gateway-control):[1-9][0-9]{0,4}$/;

export function createDockerCandidateAdapter(client: DockerClient, config: DockerConfig) {
  if (!networkPattern.test(config.network)) throw new Error('Invalid candidate network');
  if (!config.images.length || config.images.some(({ repository, digest }) =>
    !(repository === 'local' || repositoryPattern.test(repository)) || !digestPattern.test(digest))) throw new Error('Invalid approved image');
  const approvedImages = new Set(config.images.map(({ repository, digest }) => `${repository}@${digest}`));
  return {
    async startCandidate({ siteId, releaseId, image, workspaceId, credential, gatewayUrl, hostPort }: Candidate): Promise<string> {
      if (!sitePattern.test(siteId)) throw new Error('Invalid site identity');
      if (!releasePattern.test(releaseId)) throw new Error('Invalid release identity');
      if (!sitePattern.test(workspaceId)) throw new Error('Invalid workspace identity');
      if (!/^[a-f0-9]{64}$/.test(credential)) throw new Error('Invalid candidate credential');
      if (!gatewayPattern.test(gatewayUrl) || Number(new URL(gatewayUrl).port) > 65535) throw new Error('Invalid candidate gateway URL');
      if (!Number.isSafeInteger(hostPort) || hostPort < 1024 || hostPort > 65535) throw new Error('Invalid candidate port');
      if (!approvedImages.has(`${image.repository}@${image.digest}`)) throw new Error('Unapproved image');
      const imageRef = image.repository === 'local' ? image.digest : `${image.repository}@${image.digest}`;
      const name = `gateway-${siteId}-${randomUUID()}`;
      const created = await client.request({ method: 'POST', path: `/containers/create?name=${name}`, body: {
        Image: imageRef,
        User: '10001:10001',
        Env: [`SITE_ID=${siteId}`, `RELEASE_ID=${releaseId}`, `NUXT_WORKSPACE_ID=${workspaceId}`, `NUXT_SITE_ID=${siteId}`, `NUXT_GATEWAY_URL=${gatewayUrl}`, `NUXT_SITE_CREDENTIAL=${credential}`],
        Labels: { 'gateway.site-id': siteId, 'gateway.release-id': releaseId },
        HostConfig: {
          NetworkMode: config.network, ReadonlyRootfs: true, Privileged: false,
          CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
          Memory: 512 * 1024 * 1024, NanoCpus: 500_000_000, PidsLimit: 128,
          PortBindings: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: String(hostPort) }] },
        },
      } });
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(created.Id)) throw new Error('Invalid Docker container ID');
      try {
        await client.request({ method: 'POST', path: `/containers/${created.Id}/start` });
        return created.Id;
      } catch (error) {
        try { await client.request({ method: 'DELETE', path: `/containers/${created.Id}?force=true` }); }
        catch (cleanupError) {
          throw Object.assign(new Error(`Candidate cleanup failed; residual container ${created.Id} requires inspection`, { cause: error }), { containerId: created.Id, cleanupError });
        }
        throw error;
      }
    },
  };
}
