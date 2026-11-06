import { createHash } from 'node:crypto';

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const maxSnapshotBytes = 10 * 1024 * 1024;
const maxAssetBytes = 6 * 1024 * 1024;

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
  if (release && typeof release === 'object' && (release as Record<string, unknown>).contractVersion === 1) {
    const contract = validateContractSnapshotV1(release);
    if (contract.siteId !== input.siteId || contract.template.id !== metadata.templateId || contract.template.version !== metadata.templateVersion) {
      throw new Error('Release contract identity mismatch');
    }
  } else if (pages !== undefined && (!Array.isArray(pages) || pages.some(page => {
    const preset = page && typeof page === 'object' && 'content' in page ? (page as { content?: { preset?: unknown } }).content?.preset : undefined;
    return preset !== undefined && (!preset || typeof preset !== 'object' ||
      (preset as Record<string, unknown>).id !== metadata.templateId ||
      (preset as Record<string, unknown>).version !== metadata.templateVersion);
  }))) throw new Error('Release preset identity mismatch');
  if (!digestPattern.test(input.checksum ?? '') || `sha256:${createHash('sha256').update(snapshot).digest('hex')}` !== input.checksum) throw new Error('Snapshot checksum mismatch');
  return { ...input as ReleaseInput, imageDigest: metadata.imageDigest };
}

export interface ContractTemplateIdentity {
  id: string;
  version: string;
}

export interface ContractSnapshotV1 {
  contractVersion: 1;
  schemaVersion: 1;
  workspaceId: string;
  siteId: string;
  language: string;
  template: ContractTemplateIdentity;
  pages: Array<{
    path: string;
    pageKey: string;
    entryId: string;
    content: {
      kind: string;
      view: string;
      preset: ContractTemplateIdentity;
      sections: string[];
      seo: { title: string; description: string };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }>;
  navigation: Array<Record<string, unknown>>;
  redirects: Array<{ from: string; to: string }>;
  operations?: Record<string, unknown>;
  assets: Array<{ path: string; checksum: string; mimeType: string; contentBase64?: string; [key: string]: unknown }>;
}

const contractRootKeys = new Set(['contractVersion', 'schemaVersion', 'workspaceId', 'siteId', 'language', 'template', 'pages', 'navigation', 'redirects', 'operations', 'assets']);
const contractPageKeys = new Set(['path', 'pageKey', 'entryId', 'content', 'layoutDocument']);
const contractContentKeys = new Set(['kind', 'view', 'preset', 'sections', 'sectionConfigs', 'layoutDocument', 'seo', 'items', 'operations']);
const contractTemplatePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const contractVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const contractPathPattern = /^\/(?:[^/?#\\%\x00-\x1f\x7f]+(?:\/[^/?#\\%\x00-\x1f\x7f]+)*)?$/;

function contractObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function contractOnlyKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown ${label} field: ${key}`);
}

function contractIdentity(value: unknown, label: string): ContractTemplateIdentity {
  if (!contractObject(value) ||
      typeof value.id !== 'string' || !contractTemplatePattern.test(value.id) ||
      typeof value.version !== 'string' || !contractVersionPattern.test(value.version)) {
    throw new Error(`Invalid ${label} identity`);
  }
  return { id: value.id, version: value.version };
}

function contractNavigation(value: unknown, seen: Set<string>): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('Invalid contract navigation');
  return value.map(item => {
    if (!contractObject(item)) throw new Error('Invalid contract navigation node');
    const allowed = new Set(['id', 'label', 'href', 'path', 'children', 'enabled']);
    contractOnlyKeys(item, allowed, 'navigation');
    if (typeof item.id !== 'string' || !item.id || seen.has(item.id) || typeof item.label !== 'string' || !item.label ||
        (item.href !== undefined && typeof item.href !== 'string') || (item.path !== undefined && typeof item.path !== 'string') ||
        (item.href !== undefined && item.path !== undefined && item.href !== item.path) ||
        (item.enabled !== undefined && typeof item.enabled !== 'boolean')) throw new Error('Invalid contract navigation node');
    seen.add(item.id);
    contractNavigation(item.children ?? [], seen);
    return item;
  });
}

export function validateContractSnapshotV1(value: unknown): ContractSnapshotV1 {
  if (!contractObject(value)) throw new Error('Invalid contract snapshot');
  contractOnlyKeys(value, contractRootKeys, 'contract snapshot root');
  if (value.contractVersion !== 1 || value.schemaVersion !== 1 ||
      typeof value.workspaceId !== 'string' || !value.workspaceId || typeof value.siteId !== 'string' || !value.siteId ||
      typeof value.language !== 'string' || !value.language) throw new Error('Invalid contract snapshot identity');
  const template = contractIdentity(value.template, 'template');
  if (!Array.isArray(value.pages) || value.pages.length === 0) throw new Error('Contract snapshot requires pages');
  const paths = new Set<string>();
  const pages = value.pages.map(item => {
    if (!contractObject(item)) throw new Error('Invalid contract page');
    contractOnlyKeys(item, contractPageKeys, 'contract page');
    if (typeof item.path !== 'string' || !contractPathPattern.test(item.path) || paths.has(item.path) ||
        typeof item.pageKey !== 'string' || !item.pageKey || typeof item.entryId !== 'string' || !item.entryId || !contractObject(item.content)) {
      throw new Error('Invalid contract page');
    }
    paths.add(item.path);
    const content = item.content;
    contractOnlyKeys(content, contractContentKeys, 'contract content');
    const preset = contractIdentity(content.preset, 'page template');
    if (preset.id !== template.id || preset.version !== template.version ||
        typeof content.kind !== 'string' || content.kind !== 'preset-page' || typeof content.view !== 'string' ||
        !Array.isArray(content.sections) || content.sections.some(section => typeof section !== 'string') ||
        !contractObject(content.seo) || typeof content.seo.title !== 'string' || typeof content.seo.description !== 'string') {
      throw new Error('Contract page template identity mismatch');
    }
    return item as ContractSnapshotV1['pages'][number];
  });
  contractNavigation(value.navigation, new Set());
  if (!Array.isArray(value.redirects) || value.redirects.some(item => !contractObject(item) || Object.keys(item).some(key => !['from', 'to'].includes(key)) ||
      typeof item.from !== 'string' || !contractPathPattern.test(item.from) || typeof item.to !== 'string' || !contractPathPattern.test(item.to))) {
    throw new Error('Invalid contract redirects');
  }
  if (value.operations !== undefined && !contractObject(value.operations)) throw new Error('Invalid contract operations');
  const assetPaths = new Set<string>();
  if (!Array.isArray(value.assets)) throw new Error('Invalid contract assets');
  for (const item of value.assets) {
    if (!contractObject(item) || typeof item.path !== 'string' || !item.path || item.path.startsWith('/') || item.path.includes('..') || assetPaths.has(item.path) ||
        typeof item.checksum !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(item.checksum) || typeof item.mimeType !== 'string' || !item.mimeType ||
        item.mediaId !== undefined && (typeof item.mediaId !== 'string' || !item.mediaId) ||
        item.sourcePath !== undefined && (typeof item.sourcePath !== 'string' || !item.sourcePath) ||
        typeof item.contentBase64 !== 'string' || !item.contentBase64 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.contentBase64)) throw new Error('Invalid contract assets');
    if (item.contentBase64 !== undefined) {
      const contentBase64 = item.contentBase64 as string;
      const bytes = Buffer.from(contentBase64, 'base64');
      if (bytes.length > maxAssetBytes || !bytes.length || bytes.toString('base64') !== contentBase64 || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== item.checksum) {
        throw new Error('Contract asset checksum mismatch');
      }
    }
    assetPaths.add(item.path);
  }
  return { ...value, template, pages } as ContractSnapshotV1;
}
