import type { Pool } from 'pg';
import { claimPublishOperation } from './claim.js';
import { processDomainChange } from './domain-changes.js';

/** One production scheduling step: domain work precedes publication claiming. */
export async function scheduleWorkerOperations(
  pool: Pool,
  router: Parameters<typeof processDomainChange>[1],
  workerId: string,
  verify?: Parameters<typeof processDomainChange>[2],
) {
  await processDomainChange(pool, router, verify);
  return claimPublishOperation(pool, workerId, 180);
}
