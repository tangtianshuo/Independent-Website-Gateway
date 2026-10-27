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

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error('Public registry unavailable');
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > 2 * 1024 * 1024) throw new Error('Public registry response too large');
  if (!response.body) throw new Error('Public registry response unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Public registry response too large'); }
    chunks.push(value);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

export async function loadPublicTemplate(templateId: string, templateVersion: string): Promise<PublicTemplateRecord> {
  if (!idPattern.test(templateId) || !versionPattern.test(templateVersion)) throw new Error('Invalid template identity');
  const commitResponse = await fetchJson(`https://api.github.com/repos/${owner}/${repository}/commits/${registryBranch}`) as { sha?: unknown };
  if (typeof commitResponse.sha !== 'string' || !commitPattern.test(commitResponse.sha)) throw new Error('Invalid registry commit');
  const index = await fetchJson(`https://raw.githubusercontent.com/${owner}/${repository}/${commitResponse.sha}/registry/index.json`);
  const record = parseRegistryIndex(index).find(item => item.id === templateId && item.version === templateVersion);
  if (!record) throw new Error('Public template not found');
  const manifest = await fetchJson(`https://raw.githubusercontent.com/${owner}/${repository}/${record.sourceCommit}/${record.manifestPath}`);
  const checksum = `sha256:${createHash('sha256').update(canonicalJson(manifest), 'utf8').digest('hex')}`;
  if (checksum !== record.manifestChecksum) throw new Error('Public manifest checksum mismatch');
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Invalid public manifest');
  const definition = manifest as Record<string, unknown>;
  const compatibility = definition.compatibility as Record<string, unknown> | null;
  if (definition.schemaVersion !== 1 || definition.id !== record.id || definition.version !== record.version ||
      !compatibility || typeof compatibility !== 'object' || Array.isArray(compatibility) ||
      compatibility.cmsSchema !== 1 || compatibility.releaseSchema !== 1 ||
      !Array.isArray(definition.models) || !Array.isArray(definition.pages) ||
      !definition.presentation || typeof definition.presentation !== 'object' || Array.isArray(definition.presentation)) {
    throw new Error('Invalid public manifest identity or compatibility');
  }
  return record;
}
