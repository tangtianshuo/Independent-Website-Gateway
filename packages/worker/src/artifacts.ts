import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

export function artifactSnapshotPath(directory: string, siteId: string, releaseId: string): string {
  return join(directory, `${createHash('sha256').update(`${siteId}:${releaseId}`).digest('hex')}.snapshot`);
}

// Only deterministic, checksummed Gateway-owned artifacts may gain runtime read
// permission. The storage directory stays private; candidates mount one file ro.
export async function ensureArtifactReadable(directory: string, siteId: string, releaseId: string, checksum: string): Promise<string> {
  if (!/^sha256:[a-f0-9]{64}$/.test(checksum)) throw new Error('Invalid artifact checksum');
  const storage = await lstat(directory);
  if (!storage.isDirectory() || storage.isSymbolicLink()) throw new Error('Invalid artifact directory');
  const path = artifactSnapshotPath(directory, siteId, releaseId);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > 10 * 1024 * 1024) throw new Error('Invalid artifact size');
    const bytes = await file.readFile();
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== checksum) throw new Error('Artifact checksum mismatch');
    await chmod(directory, 0o700);
    await file.chmod(0o444);
  } finally { await file.close(); }
  return path;
}
