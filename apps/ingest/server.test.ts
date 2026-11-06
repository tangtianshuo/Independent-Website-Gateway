import { expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { requestIp } from './server.js';
it('only trusts explicitly configured proxy hops from the socket inward', () => {
  const request = (peer: string, header: string) =>
    ({
      socket: { remoteAddress: peer },
      headers: { 'x-forwarded-for': header },
    }) as IncomingMessage;
  const trusted = new Set(['127.0.0.1', '192.0.2.2']);
  expect(requestIp(request('198.51.100.1', '203.0.113.9'), trusted)).toBe('198.51.100.1');
  expect(
    requestIp(request('::ffff:127.0.0.1', '203.0.113.9,198.51.100.1,192.0.2.2'), trusted),
  ).toBe('198.51.100.1');
  expect(requestIp(request('127.0.0.1', '203.0.113.9,invalid'), trusted)).toBe('127.0.0.1');
});
