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

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
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
  if (!digestPattern.test(input.checksum ?? '') || `sha256:${createHash('sha256').update(snapshot).digest('hex')}` !== input.checksum) throw new Error('Snapshot checksum mismatch');
  return { ...input as ReleaseInput, imageDigest: metadata.imageDigest };
}
