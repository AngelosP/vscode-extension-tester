import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock vscode module
vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
    })),
  },
  debug: {
    registerDebugConfigurationProvider: vi.fn(() => ({ dispose: vi.fn() })),
  },
}));

import { DebugConfigProvider, registerDebugConfigProvider } from '../src/debug-config-provider.js';

describe('DebugConfigProvider', () => {
  let provider: DebugConfigProvider;

  beforeEach(() => {
    provider = new DebugConfigProvider();
  });

  describe('resolveDebugConfiguration()', () => {
    it('should inject --remote-debugging-port for extensionHost configs', () => {
      const config = {
        type: 'extensionHost',
        name: 'Run Extension',
        request: 'launch',
      };

      const result = provider.resolveDebugConfiguration(undefined, config);

      expect(result).toBeDefined();
      expect(result!.args).toBeDefined();
      expect(result!.args.some((a: string) => a.includes('--remote-debugging-port=9222'))).toBe(true);
    });

    it('should inject --user-data-dir for extensionHost configs', () => {
      const config = {
        type: 'extensionHost',
        name: 'Run Extension',
        request: 'launch',
      };

      const result = provider.resolveDebugConfiguration(undefined, config);

      expect(result!.args.some((a: string) => a.includes('--user-data-dir='))).toBe(true);
    });

    it('should inject --disable-workspace-trust', () => {
      const config = {
        type: 'extensionHost',
        name: 'Run Extension',
        request: 'launch',
      };

      const result = provider.resolveDebugConfiguration(undefined, config);

      expect(result!.args).toContain('--disable-workspace-trust');
    });

    it('should set VSCODE_EXT_TESTER_PORT env var', () => {
      const config = {
        type: 'extensionHost',
        name: 'Run Extension',
        request: 'launch',
      };

      const result = provider.resolveDebugConfiguration(undefined, config);

      expect(result!.env).toBeDefined();
      expect(result!.env['VSCODE_EXT_TESTER_PORT']).toBeDefined();
    });

    it('should not modify non-extensionHost configs', () => {
      const config = {
        type: 'node',
        name: 'Debug Node',
        request: 'launch',
      };

      const result = provider.resolveDebugConfiguration(undefined, config);

      expect(result).toEqual(config);
    });

    it('should not duplicate --remote-debugging-port if already present', () => {
      const config = {
        type: 'extensionHost',
        name: 'Run Extension',
        request: 'launch',
        args: ['--remote-debugging-port=9999'],
      };

      const result = provider.resolveDebugConfiguration(undefined, config);

      const debugPortArgs = result!.args.filter((a: string) => a.includes('--remote-debugging-port'));
      expect(debugPortArgs).toHaveLength(1);
      expect(debugPortArgs[0]).toBe('--remote-debugging-port=9999');
    });

    it('should not duplicate --user-data-dir if already present', () => {
      const config = {
        type: 'extensionHost',
        name: 'Run Extension',
        request: 'launch',
        args: ['--user-data-dir=/custom/path'],
      };

      const result = provider.resolveDebugConfiguration(undefined, config);

      const udArgs = result!.args.filter((a: string) => a.includes('--user-data-dir'));
      expect(udArgs).toHaveLength(1);
      expect(udArgs[0]).toBe('--user-data-dir=/custom/path');
    });

    it('should not duplicate --disable-workspace-trust if already present', () => {
      const config = {
        type: 'extensionHost',
        name: 'Run Extension',
        request: 'launch',
        args: ['--disable-workspace-trust'],
      };

      const result = provider.resolveDebugConfiguration(undefined, config);

      const trustArgs = result!.args.filter((a: string) => a.includes('--disable-workspace-trust'));
      expect(trustArgs).toHaveLength(1);
    });

    it('should preserve existing args', () => {
      const config = {
        type: 'extensionHost',
        name: 'Run Extension',
        request: 'launch',
        args: ['--custom-flag', '--other-flag=value'],
      };

      const result = provider.resolveDebugConfiguration(undefined, config);

      expect(result!.args).toContain('--custom-flag');
      expect(result!.args).toContain('--other-flag=value');
    });

    it('should preserve existing env vars', () => {
      const config = {
        type: 'extensionHost',
        name: 'Run Extension',
        request: 'launch',
        env: { MY_VAR: 'hello' },
      };

      const result = provider.resolveDebugConfiguration(undefined, config);

      expect(result!.env['MY_VAR']).toBe('hello');
      expect(result!.env['VSCODE_EXT_TESTER_PORT']).toBeDefined();
    });
  });

  describe('registerDebugConfigProvider()', () => {
    it('should register the provider', async () => {
      const vscode = await import('vscode');
      const context = {
        subscriptions: [] as any[],
      } as any;

      registerDebugConfigProvider(context);

      expect(vscode.debug.registerDebugConfigurationProvider).toHaveBeenCalledWith(
        'extensionHost',
        expect.any(DebugConfigProvider)
      );
      expect(context.subscriptions.length).toBeGreaterThan(0);
    });
  });
});
