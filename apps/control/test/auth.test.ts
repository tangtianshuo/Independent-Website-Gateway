import { describe, expect, it } from 'vitest';
import { authenticateService, authorizeWorkspace } from '../src/auth';

describe('service authentication', () => {
  it('rejects missing service identity', () => {
    expect(() => authenticateService(undefined, { secret: 'gateway-secret', workspaceId: 'workspace-a' })).toThrow();
  });

  it('rejects invalid service identity', () => {
    expect(() => authenticateService('Bearer wrong-secret', { secret: 'gateway-secret', workspaceId: 'workspace-a' })).toThrow();
  });

  it('rejects unconfigured service identity', () => {
    expect(() => authenticateService('Bearer ', { secret: '', workspaceId: 'workspace-a' })).toThrow();
    expect(() => authenticateService('Bearer gateway-secret', { secret: 'gateway-secret', workspaceId: '' })).toThrow();
  });

  it('derives workspace ownership from authenticated principal, not request body', () => {
    const principal = authenticateService('Bearer gateway-secret', { secret: 'gateway-secret', workspaceId: 'workspace-a' });

    expect(principal.workspaceId).toBe('workspace-a');
    expect(authorizeWorkspace(principal, 'workspace-a')).toBeUndefined();
  });

  it('denies access to another workspace', () => {
    const principal = authenticateService('Bearer gateway-secret', { secret: 'gateway-secret', workspaceId: 'workspace-a' });

    expect(() => authorizeWorkspace(principal, 'workspace-b')).toThrow();
  });
});
