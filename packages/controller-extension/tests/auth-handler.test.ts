import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock vscode module
vi.mock('vscode', () => ({
  authentication: {
    onDidChangeSessions: vi.fn(() => ({ dispose: vi.fn() })),
    getSession: vi.fn(),
  },
}));

import { AuthHandler } from '../src/auth-handler.js';

describe('AuthHandler', () => {
  let handler: AuthHandler;
  let vscode: any;

  beforeEach(async () => {
    handler = new AuthHandler();
    vscode = await import('vscode');
    vi.clearAllMocks();
  });

  describe('handleAuth()', () => {
    it('should return already_authenticated when session exists', async () => {
      vscode.authentication.getSession.mockResolvedValue({ accessToken: 'token123' });

      const result = await handler.handleAuth('microsoft', { username: 'user@test.com' });

      expect(result.status).toBe('already_authenticated');
      expect(result.provider).toBe('microsoft');
    });

    it('should return authenticated when new session is created', async () => {
      // First call (createIfNone: false) returns null
      // Second call (createIfNone: true) returns session
      vscode.authentication.getSession
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ accessToken: 'new-token' });

      const result = await handler.handleAuth('github', {});

      expect(result.status).toBe('authenticated');
      expect(result.provider).toBe('github');
    });

    it('should return cancelled when session creation returns null', async () => {
      vscode.authentication.getSession
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      const result = await handler.handleAuth('microsoft', {});

      expect(result.status).toBe('cancelled');
    });

    it('should return error when authentication throws', async () => {
      vscode.authentication.getSession.mockRejectedValue(new Error('Auth failed'));

      const result = await handler.handleAuth('microsoft', {});

      expect(result.status).toBe('error');
      expect(result.provider).toBe('microsoft');
    });
  });

  describe('getAvailableProviders()', () => {
    it('should return microsoft and github providers', () => {
      const providers = handler.getAvailableProviders();

      expect(providers).toContain('microsoft');
      expect(providers).toContain('github');
    });
  });

  describe('register()', () => {
    it('should return disposables', () => {
      const disposables = handler.register();

      expect(Array.isArray(disposables)).toBe(true);
      expect(disposables.length).toBeGreaterThan(0);
    });
  });
});
