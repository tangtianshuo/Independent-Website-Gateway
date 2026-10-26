export { canonicalJson, validateReleaseInput } from './release';
export type { ReleaseInput } from './release';

export type HealthStatus = 'ok' | 'ready' | 'not_ready';

export interface HealthResponse {
  status: HealthStatus;
  dependencies?: { postgres: 'available' | 'unavailable' };
}
