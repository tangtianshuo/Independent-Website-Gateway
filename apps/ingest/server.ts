import { createServer, type IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { Pool } from 'pg';
import { createIngestHandler } from './http.js';

const normalizedIp = (value: string) => (value.startsWith('::ffff:') ? value.slice(7) : value);
export function requestIp(
  request: IncomingMessage,
  trustedProxies: ReadonlySet<string>,
): string | undefined {
  const peer = request.socket.remoteAddress;
  if (!peer) return undefined;
  let ip = normalizedIp(peer);
  // Walk from the socket inward; the first untrusted hop is the client.
  if (!trustedProxies.has(ip)) return ip;
  const raw = request.headers['x-forwarded-for'];
  if (typeof raw !== 'string') return ip;
  const hops = raw.split(',').map((value) => normalizedIp(value.trim()));
  if (hops.some((value) => !isIP(value))) return ip;
  for (let i = hops.length - 1; i >= 0 && trustedProxies.has(ip); i--) ip = hops[i];
  return ip;
}

export function createIngestServer(pool: Pool) {
  const trusted = new Set(
    (process.env.INGEST_TRUSTED_PROXY_IPS || '')
      .split(',')
      .map((value) => normalizedIp(value.trim()))
      .filter(Boolean),
  );
  if ([...trusted].some((value) => !isIP(value)))
    throw new Error('INGEST_TRUSTED_PROXY_IPS requires explicit IP addresses');
  const ips = new WeakMap<Request, string>();
  const handler = createIngestHandler(pool, { clientIp: (request) => ips.get(request) });
  return createServer(async (incoming, outgoing) => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers))
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(',') : value);
      const request = new Request(new URL(incoming.url || '/', 'http://ingest.internal'), {
        method: incoming.method,
        headers,
        ...(!['GET', 'HEAD'].includes(incoming.method || 'GET')
          ? { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: 'half' }
          : {}),
      } as RequestInit);
      const ip = requestIp(incoming, trusted);
      if (ip) ips.set(request, ip);
      const response = await handler(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      outgoing.end(JSON.stringify({ error: 'intake_unavailable', retryable: true }));
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 3000,
  });
  const server = createIngestServer(pool);
  server.listen(Number(process.env.PORT || 18184), process.env.HOST || '127.0.0.1', () =>
    console.log(`ingest listening pid=${process.pid}`),
  );
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      server.close(() => {
        void pool.end();
      });
    });
}
