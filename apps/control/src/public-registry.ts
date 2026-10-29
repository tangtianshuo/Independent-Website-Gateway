import { createHash } from 'node:crypto';
import { canonicalJson } from '@gateway/contracts';

const owner = 'tangtianshuo';
const repository = 'Independent-Website-Templates';
const registryBranch = 'registry';
const checksumPattern = /^sha256:[a-f0-9]{64}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const versionPattern = /^\d+\.\d+\.\d+$/;
const commitPattern = /^[a-f0-9]{40}$/;

type RegistryStage = 'identity' | 'registry_commit' | 'registry_index' | 'manifest';
type RegistryFailureReason = 'invalid_identity' | 'timeout' | 'network' | 'rate_limited' | 'http_error' |
  'response_too_large' | 'response_missing' | 'invalid_json' | 'invalid_commit' | 'invalid_index' |
  'template_not_found' | 'checksum_mismatch' | 'invalid_manifest';
interface RegistryDiagnostic {
  stage: RegistryStage; reason: RegistryFailureReason; elapsedMs: number;
  status?: number; networkCode?: string; rateLimitRemaining?: number;
  rateLimitReset?: number; retryAfterSeconds?: number;
}

export class PublicRegistryError extends Error {
  constructor(readonly diagnostic: RegistryDiagnostic) {
    super(`Public template ${diagnostic.stage}: ${diagnostic.reason}`);
    this.name = 'PublicRegistryError';
  }

  get unavailable(): boolean {
    return ['timeout', 'network', 'rate_limited', 'http_error'].includes(this.diagnostic.reason);
  }
}

function failure(stage: RegistryStage, reason: RegistryFailureReason, started: number,
  details: Partial<Omit<RegistryDiagnostic, 'stage' | 'reason' | 'elapsedMs'>> = {}): PublicRegistryError {
  return new PublicRegistryError({ stage, reason, elapsedMs: Date.now() - started, ...details });
}

function integerHeader(response: Response, name: string): number | undefined {
  const raw = response.headers.get(name);
  if (raw === null || !/^\d{1,15}$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

export interface PublicTemplateRecord {
  schemaVersion: 1; id: string; version: string; manifestChecksum: string;
  imageRepository: string; imageDigest: string; sourceCommit: string;
  manifestPath: string; status: 'available';
}

function validRecord(value: unknown): value is PublicTemplateRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return r.schemaVersion === 1 && typeof r.id === 'string' && idPattern.test(r.id) &&
    typeof r.version === 'string' && versionPattern.test(r.version) &&
    typeof r.manifestChecksum === 'string' && checksumPattern.test(r.manifestChecksum) &&
    r.imageRepository === `ghcr.io/${owner.toLowerCase()}/${repository.toLowerCase()}/${r.id}` &&
    typeof r.imageDigest === 'string' && digestPattern.test(r.imageDigest) &&
    typeof r.sourceCommit === 'string' && commitPattern.test(r.sourceCommit) &&
    r.manifestPath === `templates/${r.id}/${r.version}/template.json` && r.status === 'available';
}

export function parseRegistryIndex(value: unknown): PublicTemplateRecord[] {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>).schemaVersion !== 1 || !Array.isArray((value as Record<string, unknown>).records)) throw new Error('Invalid registry index');
  const records = (value as { records: unknown[] }).records;
  if (records.some(record => !validRecord(record))) throw new Error('Invalid registry record');
  const keys = (records as PublicTemplateRecord[]).map(record => `${record.id}@${record.version}`);
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate registry record');
  return records as PublicTemplateRecord[];
}

async function fetchJson(url: string, stage: RegistryStage): Promise<unknown> {
  const started = Date.now();
  const signal = AbortSignal.timeout(5000);
  try {
    const response = await fetch(url, { redirect: 'error', signal, headers: { accept: 'application/vnd.github+json' } });
    if (!response.ok) {
      const details = { status: response.status, rateLimitRemaining: integerHeader(response, 'x-ratelimit-remaining'),
        rateLimitReset: integerHeader(response, 'x-ratelimit-reset'), retryAfterSeconds: integerHeader(response, 'retry-after') };
      await response.body?.cancel().catch(() => undefined);
      const limited = response.status === 429 || (response.status === 403 && (details.rateLimitRemaining === 0 || details.retryAfterSeconds !== undefined));
      throw failure(stage, limited ? 'rate_limited' : 'http_error', started, details);
    }
    if (Number(response.headers.get('content-length') ?? 0) > 2 * 1024 * 1024) {
      await response.body?.cancel().catch(() => undefined);
      throw failure(stage, 'response_too_large', started);
    }
    if (!response.body) throw failure(stage, 'response_missing', started);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) {
          await reader.cancel().catch(() => undefined);
          throw failure(stage, 'response_too_large', started);
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw failure(stage, 'invalid_json', started); }
  } catch (error) {
    if (error instanceof PublicRegistryError) throw error;
    const timeout = signal.aborted || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name));
    const code = error instanceof Error && error.cause && typeof error.cause === 'object' && 'code' in error.cause ? error.cause.code : undefined;
    const networkCode = typeof code === 'string' && ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code) ? code : undefined;
    throw failure(stage, timeout ? 'timeout' : 'network', started, { networkCode });
  }
}

export async function loadPublicTemplate(templateId: string, templateVersion: string): Promise<PublicTemplateRecord> {
  let started = Date.now();
  if (!idPattern.test(templateId) || !versionPattern.test(templateVersion)) throw failure('identity', 'invalid_identity', started);
  const commitResponse = await fetchJson(`https://api.github.com/repos/${owner}/${repository}/commits/${registryBranch}`, 'registry_commit') as { sha?: unknown } | null;
  if (!commitResponse || typeof commitResponse.sha !== 'string' || !commitPattern.test(commitResponse.sha)) throw failure('registry_commit', 'invalid_commit', started);
  started = Date.now();
  const index = await fetchJson(`https://raw.githubusercontent.com/${owner}/${repository}/${commitResponse.sha}/registry/index.json`, 'registry_index');
  let records: PublicTemplateRecord[];
  try { records = parseRegistryIndex(index); }
  catch { throw failure('registry_index', 'invalid_index', started); }
  const record = records.find(item => item.id === templateId && item.version === templateVersion);
  if (!record) throw failure('registry_index', 'template_not_found', started);
  started = Date.now();
  const manifest = await fetchJson(`https://raw.githubusercontent.com/${owner}/${repository}/${record.sourceCommit}/${record.manifestPath}`, 'manifest');
  const checksum = `sha256:${createHash('sha256').update(canonicalJson(manifest), 'utf8').digest('hex')}`;
  if (checksum !== record.manifestChecksum) throw failure('manifest', 'checksum_mismatch', started);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw failure('manifest', 'invalid_manifest', started);
  const definition = manifest as Record<string, unknown>;
  const compatibility = definition.compatibility as Record<string, unknown> | null;
  if (definition.schemaVersion !== 1 || definition.id !== record.id || definition.version !== record.version ||
      !compatibility || typeof compatibility !== 'object' || Array.isArray(compatibility) ||
      compatibility.cmsSchema !== 1 || compatibility.releaseSchema !== 1 ||
      !Array.isArray(definition.models) || !Array.isArray(definition.pages) ||
      !definition.presentation || typeof definition.presentation !== 'object' || Array.isArray(definition.presentation)) {
    throw failure('manifest', 'invalid_manifest', started);
  }
  return record;
}
