import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET as live } from '../app/api/v1/health/live/route';
import { GET as ready } from '../app/api/v1/health/ready/route';
import { Client } from 'pg';

vi.mock('pg', () => ({
  Client: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(Client).mockReset().mockImplementation(function () {
    throw new Error('Unexpected PostgreSQL client construction');
  });
  delete process.env.DATABASE_URL;
});

describe('health endpoint routes', () => {
  it.each(['connect', 'query', 'end'] as const)('returns 503 by the deadline when PostgreSQL %s hangs', async (stage) => {
    process.env.DATABASE_URL = 'postgresql://gateway:secret@localhost:5432/gateway';
    const connect = vi.fn().mockImplementation(() => stage === 'connect' ? new Promise(() => undefined) : Promise.resolve());
    const query = vi.fn().mockImplementation(() => stage === 'query' ? new Promise(() => undefined) : Promise.resolve({ rows: [{ '?column?': 1 }] }));
    const end = vi.fn().mockImplementation(() => stage === 'end' ? new Promise(() => undefined) : Promise.resolve());
    const destroy = vi.fn();
    vi.mocked(Client).mockImplementation(function () {
      return { connect, query, end, connection: { stream: { destroy } } } as unknown as Client;
    });

    const startedAt = Date.now();
    const response = await ready(new Request('http://localhost/api/v1/health/ready'));

    expect(response.status).toBe(503);
    expect(Date.now() - startedAt).toBeLessThan(2500);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('destroys a stalled PostgreSQL stream by the total deadline', async () => {
    vi.useFakeTimers();
    process.env.DATABASE_URL = 'postgresql://gateway:secret@localhost:5432/gateway';
    const connect = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const end = vi.fn().mockImplementation(() => new Promise(() => undefined));
    const destroy = vi.fn();
    vi.mocked(Client).mockImplementation(function () {
      return { connect, query, end, connection: { stream: { destroy } } } as unknown as Client;
    });

    const startedAt = Date.now();
    const responsePromise = ready(new Request('http://localhost/api/v1/health/ready'));
    await vi.advanceTimersByTimeAsync(1999);
    expect(destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(destroy).toHaveBeenCalledOnce();
    const response = await responsePromise;
    const elapsed = Date.now() - startedAt;

    expect(response.status).toBe(503);
    expect(elapsed).toBe(2000);
  });

  it('destroys the connection when the query settles after the total deadline', async () => {
    vi.useFakeTimers();
    process.env.DATABASE_URL = 'postgresql://gateway:secret@localhost:5432/gateway';
    const startedAt = Date.now();
    const destroy = vi.fn();
    const connect = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockImplementation(async () => {
      vi.setSystemTime(startedAt + 2000);
      return { rows: [{ '?column?': 1 }] };
    });
    const end = vi.fn().mockResolvedValue(undefined);
    vi.mocked(Client).mockImplementation(function () {
      return { connect, query, end, connection: { stream: { destroy } } } as unknown as Client;
    });

    const response = await ready(new Request('http://localhost/api/v1/health/ready'));

    expect(response.status).toBe(503);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('registers the expected URLs in the Next route manifest', async () => {
    const manifest = JSON.parse(await readFile(new URL('../.next-test/server/app-paths-manifest.json', import.meta.url), 'utf8')) as Record<string, string>;

    expect(manifest['/api/v1/health/live/route']).toBe('app/api/v1/health/live/route.js');
    expect(manifest['/api/v1/health/ready/route']).toBe('app/api/v1/health/ready/route.js');
    expect(manifest['/api/health/ready/route']).toBeUndefined();
    expect(manifest['/api/health/live/route']).toBeUndefined();
  });

  it('maps the live URL to an immediate successful response', async () => {
    const response = await live(new Request('http://localhost/api/v1/health/live'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('executes SELECT 1 using PostgreSQL credentials before reporting ready', async () => {
    process.env.DATABASE_URL = 'postgresql://gateway:secret@localhost:5432/gateway';
    const query = vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const connect = vi.fn().mockResolvedValue(undefined);
    const end = vi.fn().mockResolvedValue(undefined);
    vi.mocked(Client).mockImplementation(function () {
      return { connect, query, end } as unknown as Client;
    });

    const response = await ready(new Request('http://localhost/api/v1/health/ready'));

    expect(response.status).toBe(200);
    expect(query).toHaveBeenCalledWith('SELECT 1');
    expect(connect).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it('returns 503 when PostgreSQL authentication or query fails', async () => {
    process.env.DATABASE_URL = 'postgresql://gateway:secret@localhost:5432/gateway';
    const connect = vi.fn().mockRejectedValue(new Error('authentication failed'));
    const end = vi.fn().mockResolvedValue(undefined);
    vi.mocked(Client).mockImplementation(function () {
      return { connect, query: vi.fn(), end } as unknown as Client;
    });

    const response = await ready(new Request('http://localhost/api/v1/health/ready'));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: 'not_ready', dependencies: { postgres: 'unavailable' } });
  });

  it('returns 503 for a missing or invalid PostgreSQL URL', async () => {
    delete process.env.DATABASE_URL;
    const missingResponse = await ready(new Request('http://localhost/api/v1/health/ready'));
    expect(missingResponse.status).toBe(503);

    process.env.DATABASE_URL = 'http://localhost:5432';
    const invalidResponse = await ready(new Request('http://localhost/api/v1/health/ready'));
    expect(invalidResponse.status).toBe(503);
    expect(Client).toHaveBeenCalledOnce();
  });
});
