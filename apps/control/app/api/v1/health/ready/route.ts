import type { HealthResponse } from '@gateway/contracts';
import { Client } from 'pg';

async function postgresReady() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return false;

  const deadline = Date.now() + 2000;
  let client: Client | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    client = new Client({
      connectionString,
      connectionTimeoutMillis: 2000,
      query_timeout: 2000,
      statement_timeout: 2000,
    });
    const operation = (async () => {
      await client!.connect();
      await client!.query('SELECT 1');
      if (Date.now() >= deadline) {
        client!.connection.stream.destroy();
        return false;
      }
      await client!.end();
      if (Date.now() >= deadline) {
        client!.connection.stream.destroy();
        return false;
      }
      return true;
    })();
    const remaining = Math.max(0, deadline - Date.now());
    return await Promise.race([
      operation,
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => {
          client?.connection.stream.destroy();
          resolve(false);
        }, remaining);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function GET(_request: Request) {
  const postgresAvailable = await postgresReady();
  const body: HealthResponse = {
    status: postgresAvailable ? 'ready' : 'not_ready',
    dependencies: { postgres: postgresAvailable ? 'available' : 'unavailable' },
  };
  return Response.json(body, { status: postgresAvailable ? 200 : 503 });
}
