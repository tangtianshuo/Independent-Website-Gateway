import { createServer, request as httpRequest, type Server } from 'node:http';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface Route { siteId: string; revision: number; port: number; host: string; token: string; containerId?: string; releaseId?: string }
const hostPattern = /^(?=.{1,253}$)[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/;
const containerPattern = /^[a-zA-Z0-9_-]{1,128}$/;

export function checkCandidate(port: number, host: string, path = '/healthz'): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !hostPattern.test(host)) return Promise.resolve(false);
  return new Promise(resolve => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET', headers: { Host: host }, timeout: 3000 }, response => {
      response.resume();
      resolve(path === '/' ? response.statusCode === 200 : response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 400);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
    request.end();
  });
}

function validRoute(route: Route): boolean {
  return !!route && typeof route.siteId === 'string' && !!route.siteId && Number.isSafeInteger(route.revision) && route.revision >= 0 &&
    Number.isSafeInteger(route.port) && route.port >= 1024 && route.port <= 65535 &&
    typeof route.host === 'string' && hostPattern.test(route.host) && typeof route.token === 'string' && !!route.token &&
    typeof route.containerId === 'string' && containerPattern.test(route.containerId) &&
    typeof route.releaseId === 'string' && !!route.releaseId;
}

export function createLocalRouter(statePath?: string, validateTarget?: (route: Route) => Promise<boolean>) {
  const routes = new Map<string, Route>();
  const previous = new Map<string, Route>();
  async function persist(current: Map<string, Route>, prior: Map<string, Route>) {
    if (!statePath) return;
    const temp = `${statePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ routes: [...current.values()], previous: [...prior.values()] })); await file.sync(); }
      finally { await file.close(); }
      await rename(temp, statePath);
      if (process.platform !== 'win32') {
        const directory = await open(dirname(statePath), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally { await unlink(temp).catch(() => undefined); }
  }
  const server: Server = createServer((request, response) => {
    const host = request.headers.host?.toLowerCase().replace(/:\d+$/, '');
    const route = host && [...routes.values()].find(item => item.host === host);
    if (!route) { response.writeHead(404); response.end(); return; }
    void (async () => {
      if (validateTarget && !await validateTarget(route)) { response.writeHead(502); response.end(); return; }
      const upstream = httpRequest({ hostname: '127.0.0.1', port: route.port, path: request.url, method: request.method,
        headers: { ...request.headers, host: route.host }, timeout: 10000 }, result => {
        response.writeHead(result.statusCode ?? 502, result.headers); result.pipe(response);
      });
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      request.pipe(upstream);
    })().catch(() => { if (!response.headersSent) response.writeHead(502); response.end(); });
  });
  return {
    listen(port: number) { return new Promise<void>((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve)); },
    port() { const address = server.address(); return address && typeof address !== 'string' ? address.port : 0; },
    close() { server.closeAllConnections(); return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
    protectedRoutes(): Route[] { return [...routes.values(), ...previous.values()].map(route => ({ ...route })); },
    readRoute(siteId: string): Promise<Route | undefined> { return Promise.resolve(routes.get(siteId)); },
    async applyRoute(siteId: string, revision: number, port: number, host: string, token: string, containerId?: string, releaseId?: string) {
      const route = { siteId, revision, port, host, token, containerId, releaseId };
      if (!hostPattern.test(host) || !Number.isSafeInteger(port) || port < 1024 || port > 65535 ||
          (statePath && !validRoute(route))) throw new Error('Invalid route');
      const next = new Map(routes);
      const prior = new Map(previous);
      const old = routes.get(siteId);
      if (old && validRoute(old)) prior.set(siteId, old);
      else prior.delete(siteId);
      next.set(siteId, route);
      await persist(next, prior);
      routes.set(siteId, route);
      if (prior.has(siteId)) previous.set(siteId, prior.get(siteId)!); else previous.delete(siteId);
    },
    async verifyRoute(siteId: string, revision: number, host: string) {
      const route = routes.get(siteId);
      return !!route && route.revision === revision && route.host === host &&
        (!validateTarget || await validateTarget(route)) && await checkCandidate(this.port(), host, '/');
    },
    async restoreRoute(siteId: string, token: string, old: Route | undefined) {
      if (routes.get(siteId)?.token !== token) return false;
      const next = new Map(routes);
      const prior = new Map(previous);
      if (old) next.set(siteId, old); else next.delete(siteId);
      prior.delete(siteId);
      await persist(next, prior);
      if (old) routes.set(siteId, old); else routes.delete(siteId);
      previous.delete(siteId);
      return true;
    },
    async recover(activeDeployments: () => Promise<{ siteId: string; releaseId: string; routeRevision: number }[]>, valid: (route: Route) => Promise<boolean>) {
      if (!statePath) return;
      let saved: { routes: Route[]; previous: Route[] };
      try { saved = JSON.parse(await readFile(statePath, 'utf8')) as typeof saved; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      if (!Array.isArray(saved.routes) || !Array.isArray(saved.previous)) throw new Error('Invalid route state');
      const active = await activeDeployments();
      const all = [...saved.routes, ...saved.previous];
      const recovered = new Map<string, Route>();
      for (const deployment of active) {
        const match = all.find(route => validRoute(route) && route.siteId === deployment.siteId &&
          route.revision === deployment.routeRevision && route.releaseId === deployment.releaseId);
        if (match && await valid(match) && await checkCandidate(match.port, match.host, '/')) recovered.set(match.siteId, match);
      }
      routes.clear(); previous.clear();
      for (const [site, route] of recovered) {
        routes.set(site, route);
        const prior = saved.previous.find(item => validRoute(item) && item.siteId === site && item.containerId !== route.containerId);
        if (prior) previous.set(site, prior);
      }
    },
  };
}
