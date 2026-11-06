import { chmod, copyFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validDomainHost } from './domain-challenge.js';

export interface RouteStateEntry {
  siteId: string;
  revision: number;
  port: number;
  host: string;
  redirectHosts?: string[];
  token: string;
  containerId: string;
  releaseId: string;
}

export interface RouteStateSnapshot {
  routes: RouteStateEntry[];
  previous: RouteStateEntry[];
}

function validRoute(value: unknown): value is RouteStateEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const route = value as Partial<RouteStateEntry>;
  const revision = route.revision; const port = route.port;
  return typeof route.siteId === 'string' && !!route.siteId && typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0 &&
    typeof port === 'number' && Number.isSafeInteger(port) && port >= 1024 && port <= 65535 && typeof route.host === 'string' &&
    /^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/.test(route.host) && typeof route.token === 'string' && !!route.token &&
    typeof route.containerId === 'string' && !!route.containerId && typeof route.releaseId === 'string' && !!route.releaseId &&
    (route.redirectHosts === undefined || (Array.isArray(route.redirectHosts) && route.redirectHosts.every(host => typeof host === 'string' && /^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/.test(host))));
}

async function readState(path: string): Promise<RouteStateSnapshot> {
  const value = JSON.parse(await readFile(path, 'utf8')) as Partial<RouteStateSnapshot>;
  if (!Array.isArray(value.routes) || !Array.isArray(value.previous) ||
      value.routes.some(route => !validRoute(route)) || value.previous.some(route => !validRoute(route))) {
    throw new Error('Invalid route state');
  }
  return { routes: value.routes, previous: value.previous };
}

export async function backupRouteState(sourcePath: string, backupPath: string): Promise<void> {
  await readState(sourcePath);
  await mkdir(dirname(backupPath), { recursive: true });
  await copyFile(sourcePath, backupPath);
  await chmod(backupPath, 0o600);
}

export async function restoreRouteState(backupPath: string, destinationPath: string): Promise<void> {
  await readState(backupPath);
  await mkdir(dirname(destinationPath), { recursive: true });
  const temporaryPath = `${destinationPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await copyFile(backupPath, temporaryPath);
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, destinationPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function writeDomainState(path: string, hosts: readonly string[]): Promise<void> {
  if (hosts.some(host => !validDomainHost(host))) throw new Error('Invalid domain state');
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporaryPath, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ hosts: [...new Set(hosts)].sort() })); await file.sync(); }
    finally { await file.close(); }
    await rename(temporaryPath, path);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await rm(temporaryPath, { force: true }); }
}

export async function readDomainState(path: string): Promise<ReadonlySet<string>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || !('hosts' in value) || !Array.isArray(value.hosts) || value.hosts.some(host => typeof host !== 'string' || !validDomainHost(host))) return new Set();
    return new Set(value.hosts);
  } catch { return new Set(); }
}
