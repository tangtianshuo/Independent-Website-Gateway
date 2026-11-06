import { createHmac } from 'node:crypto';

export const challengePath = '/.well-known/cms-domain-challenge';
export const validDomainHost = (host: string): boolean => host.length <= 253 && host.includes('.') && host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));

/** Reservations authorize this proof only, never content delivery. */
export function challengeResponse(host: string, nonce: string, allowedHosts: ReadonlySet<string>, secret: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(nonce)) throw new Error('Invalid nonce');
  if (!secret || !validDomainHost(host) || !allowedHosts.has(host)) return null;
  return createHmac('sha256', secret).update(`cms-domain-v1:${host}:${nonce}`).digest('hex');
}
