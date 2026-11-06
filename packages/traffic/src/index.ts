import { createServer, request as httpRequest, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
export { backupRouteState, restoreRouteState } from './state.js';

export interface TrafficRoute {
  siteId: string;
  revision: number;
  port: number;
  host: string;
  redirectHosts?: string[];
  token: string;
  containerId?: string;
  releaseId?: string;
}

interface RouteSnapshot { routes: TrafficRoute[] }
const hostPattern = /^(?=.{1,253}$)[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/;

function validRoute(value: unknown): value is TrafficRoute {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const route = value as Partial<TrafficRoute>;
  return typeof route.siteId === 'string' && !!route.siteId && typeof route.revision === 'number' && Number.isSafeInteger(route.revision) && route.revision >= 0 &&
    typeof route.port === 'number' && Number.isSafeInteger(route.port) && route.port >= 1024 && route.port <= 65535 &&
    typeof route.host === 'string' && hostPattern.test(route.host) && typeof route.token === 'string' && !!route.token &&
    typeof route.containerId === 'string' && typeof route.releaseId === 'string' && !!route.releaseId &&
    (route.redirectHosts === undefined || (Array.isArray(route.redirectHosts) && route.redirectHosts.every(host => typeof host === 'string' && hostPattern.test(host))));
}

async function readRoutes(statePath: string): Promise<TrafficRoute[]> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(statePath, 'utf8')); } catch { return []; }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as RouteSnapshot).routes)) return [];
  return (parsed as RouteSnapshot).routes.filter(validRoute);
}

export function createTrafficProxy(statePath: string) {
  let server: Server | undefined;
  const handler = async (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      const routes = await readRoutes(statePath);
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ status: 'ok', routeCount: routes.length }));
      return;
    }
    const host = request.headers.host?.toLowerCase().replace(/:\d+$/, '');
    const routes = await readRoutes(statePath);
    const route = host ? routes.find(item => item.host === host || item.redirectHosts?.includes(host)) : undefined;
    if (!route) { response.writeHead(404); response.end(); return; }
    if (host !== route.host && route.redirectHosts?.includes(host!)) {
      response.writeHead(301, { location: `https://${route.host}${request.url || '/'}`, 'cache-control': 'no-store' });
      response.end();
      return;
    }
    const upstream = httpRequest({ hostname: '127.0.0.1', port: route.port, path: request.url, method: request.method,
      headers: { ...request.headers, host: route.host }, timeout: 10000 }, result => {
      response.writeHead(result.statusCode ?? 502, result.headers); result.pipe(response);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(upstream);
  };
  return {
    listen(port: number) {
      server = createServer((request, response) => { void handler(request, response).catch(() => { if (!response.headersSent) response.writeHead(502); response.end(); }); });
      return new Promise<void>((resolve, reject) => server!.once('error', reject).listen(port, '0.0.0.0', resolve));
    },
    port() { const address = server?.address(); return address && typeof address !== 'string' ? address.port : 0; },
    close() { server?.closeAllConnections(); return new Promise<void>((resolve, reject) => server ? server.close(error => error ? reject(error) : resolve()) : resolve()); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const statePath = process.env.GATEWAY_ROUTE_STATE_PATH ?? './gateway-routes.json';
  const port = Number(process.env.GATEWAY_PROXY_PORT ?? 8080);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid traffic proxy port');
  const proxy = createTrafficProxy(statePath);
  await proxy.listen(port);
  console.info(`Gateway traffic proxy listening on ${port}`);
  const stop = () => { void proxy.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
