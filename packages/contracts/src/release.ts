import { createHash } from 'node:crypto';

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const maxSnapshotBytes = 10 * 1024 * 1024;

export interface ReleaseInput {
  siteId: string;
  releaseId: string;
  checksum: string;
  metadata: {
    templateId: string;
    templateVersion: string;
    manifestChecksum: string;
    imageDigest: string;
  };
  snapshot: string;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function validateReleaseInput(value: unknown, allowedTemplateIds: string[]): ReleaseInput & { imageDigest: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid release');
  const input = value as Partial<ReleaseInput>;
  if (typeof input.siteId !== 'string' || !input.siteId || input.siteId.length > 128) throw new Error('Invalid site identity');
  if (typeof input.releaseId !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(input.releaseId)) throw new Error('Invalid release identity');
  if (typeof input.snapshot !== 'string') throw new Error('Invalid snapshot');
  const snapshot = Buffer.from(input.snapshot, 'base64');
  if (!snapshot.length || snapshot.length > maxSnapshotBytes || snapshot.toString('base64') !== input.snapshot) throw new Error('Invalid snapshot');
  const metadata = input.metadata;
  if (!metadata || typeof metadata !== 'object' || !allowedTemplateIds.includes(metadata.templateId)) throw new Error('Template not allowed');
  if (!metadata.templateVersion || metadata.templateVersion.length > 64 || !digestPattern.test(metadata.manifestChecksum) || !digestPattern.test(metadata.imageDigest)) throw new Error('Invalid template identity');
  let release: unknown;
  try { release = JSON.parse(snapshot.toString('utf8')); } catch { throw new Error('Invalid snapshot JSON'); }
  const pages = release && typeof release === 'object' && 'pages' in release ? (release as { pages: unknown }).pages : undefined;
  if (pages !== undefined && (!Array.isArray(pages) || pages.some(page => {
    const preset = page && typeof page === 'object' && 'content' in page ? (page as { content?: { preset?: unknown } }).content?.preset : undefined;
    return preset !== undefined && (!preset || typeof preset !== 'object' ||
      (preset as Record<string, unknown>).id !== metadata.templateId ||
      (preset as Record<string, unknown>).version !== metadata.templateVersion);
  }))) throw new Error('Release preset identity mismatch');
  if (!digestPattern.test(input.checksum ?? '') || `sha256:${createHash('sha256').update(snapshot).digest('hex')}` !== input.checksum) throw new Error('Snapshot checksum mismatch');
  return { ...input as ReleaseInput, imageDigest: metadata.imageDigest };
}
