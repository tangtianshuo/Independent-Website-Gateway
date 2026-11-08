export const retryableFailureCodes = [
  "registry_unavailable",
  "gateway_unavailable",
  "docker_unavailable",
] as const;

export type RetryableFailureCode = (typeof retryableFailureCodes)[number];

export function retryDelayMs(attempt: number, code: string): number | null {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt >= 8) return null;
  if (!(retryableFailureCodes as readonly string[]).includes(code)) return null;
  return Math.min(5_000 * 2 ** (attempt - 1), 300_000);
}
