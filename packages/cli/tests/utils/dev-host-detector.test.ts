import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as cp from 'node:child_process';

// We need to mock child_process before importing dev-host-detector
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

// Dynamic import to allow mocking
const { detectDevHost, waitForDevHost } = await import('../../src/utils/dev-host-detector.js');

describe('dev-host-detector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('detectDevHost()', () => {
    it('should return null when no Dev Host is found', async () => {
      (cp.execSync as any).mockReturnValue('normal processes without extension dev');

      const result = await detectDevHost();
      expect(result).toBeNull();
    });

    it('should detect Dev Host from process output', async () => {
      const output = `
Node,ProcessId,CommandLine
MYPC,12345,"C:\\Program Files\\Microsoft VS Code\\Code.exe" --extensionDevelopmentPath=C:\\my-extension
`;
      (cp.execSync as any).mockReturnValue(output);

      const result = await detectDevHost();
      expect(result).not.toBeNull();
      expect(result!.pid).toBe(12345);
      expect(result!.extensionPath).toBe('C:\\my-extension');
    });

    it('should return null when command fails', async () => {
      (cp.execSync as any).mockImplementation(() => {
        throw new Error('command not found');
      });

      const result = await detectDevHost();
      expect(result).toBeNull();
    });

    it('should handle --extensionDevelopmentPath with space separator', async () => {
      const output = `user 54321 code --extensionDevelopmentPath /home/user/my-ext --other-flag`;
      (cp.execSync as any).mockReturnValue(output);

      const result = await detectDevHost();
      expect(result).not.toBeNull();
      expect(result!.extensionPath).toBe('/home/user/my-ext');
    });

    it('should filter Dev Hosts by extension path when provided', async () => {
      const output = `
Node,ProcessId,CommandLine
MYPC,11111,"Code.exe" --extensionDevelopmentPath=C:\\other-extension
MYPC,22222,"Code.exe" --extensionDevelopmentPath=C:\\my-extension
`;
      (cp.execSync as any).mockReturnValue(output);

      const result = await detectDevHost('C:\\my-extension');

      expect(result).not.toBeNull();
      expect(result!.pid).toBe(22222);
      expect(result!.extensionPath).toBe('C:\\my-extension');
    });

    it('should parse user data dir and CDP port from process args', async () => {
      const output = `user 54321 code --extensionDevelopmentPath /home/user/my-ext --user-data-dir "/tmp/dev host" --remote-debugging-port=9333`;
      (cp.execSync as any).mockReturnValue(output);

      const result = await detectDevHost();

      expect(result).not.toBeNull();
      expect(result!.pid).toBe(54321);
      expect(result!.userDataDir).toBe('/tmp/dev host');
      expect(result!.cdpPort).toBe(9333);
    });
  });

  describe('waitForDevHost()', () => {
    it('should return immediately when Dev Host is already running', async () => {
      const output = `user 99999 code --extensionDevelopmentPath /path/to/ext`;
      (cp.execSync as any).mockReturnValue(output);

      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const result = await waitForDevHost(5000);

      expect(result.pid).toBe(99999);
      spy.mockRestore();
    });

    it('should throw when Dev Host not found within timeout', async () => {
      (cp.execSync as any).mockReturnValue('no dev host here');

      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await expect(waitForDevHost(100)).rejects.toThrow('Extension Development Host not found');
      spy.mockRestore();
    });
  });
});
