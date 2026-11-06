import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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
