export { canonicalJson, validateContractSnapshotV1, validateReleaseInput } from './release';
export type { ContractSnapshotV1, ContractTemplateIdentity, ReleaseInput } from './release';

export type HealthStatus = 'ok' | 'ready' | 'not_ready';

export interface HealthResponse {
  status: HealthStatus;
  dependencies?: { postgres: 'available' | 'unavailable' };
}
