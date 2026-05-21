import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { mockResolveVSCodeCli, mockGetVSCodeCliMetadata, mockSpawnVSCodeCli, mockBuildExtension } = vi.hoisted(() => ({
  mockResolveVSCodeCli: vi.fn(),
  mockGetVSCodeCliMetadata: vi.fn(),
  mockSpawnVSCodeCli: vi.fn(),
  mockBuildExtension: vi.fn(),
}));

vi.mock('../src/utils/vscode-cli.js', () => ({
  resolveVSCodeCli: mockResolveVSCodeCli,
  getVSCodeCliMetadata: mockGetVSCodeCliMetadata,
  formatVSCodeCliMissingMessage: () => 'VS Code CLI not found.',
  execVSCodeCliSync: vi.fn(),
  spawnVSCodeCli: mockSpawnVSCodeCli,
}));

vi.mock('../src/build.js', () => ({
  buildExtension: mockBuildExtension,
}));

const { openProfile } = await import('../src/profile.js');

describe('openProfile', () => {
  let originalCwd: string;
  let tempDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-ext-test-profile-open-'));
    process.chdir(tempDir);
    mockResolveVSCodeCli.mockReset();
    mockGetVSCodeCliMetadata.mockReset();
    mockSpawnVSCodeCli.mockReset();
    mockBuildExtension.mockReset();
    mockResolveVSCodeCli.mockReturnValue({
      command: 'code.cmd',
      displayName: 'VS Code',
      source: 'path',
      variant: 'stable',
      requiresShell: true,
    });
    mockGetVSCodeCliMetadata.mockReturnValue({
      command: 'code.cmd',
      displayName: 'VS Code',
      source: 'path',
      variant: 'stable',
      version: '1.121.0',
      executablePath: 'C:\\VS Code\\Code.exe',
    });
    mockSpawnVSCodeCli.mockReturnValue({ unref: vi.fn() });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not create profile directories when VS Code CLI cannot be resolved', () => {
    mockResolveVSCodeCli.mockReturnValue(null);

    expect(() => openProfile('missing-cli')).toThrow('VS Code CLI not found.');

    expect(fs.existsSync(path.join(
      tempDir,
      'tests',
      'vscode-extension-tester',
      'profiles',
      'missing-cli',
    ))).toBe(false);
  });

  it('writes VS Code install metadata into the profile manifest', () => {
    openProfile('with-metadata');

    const manifestPath = path.join(
      tempDir,
      'tests',
      'vscode-extension-tester',
      'profiles',
      'with-metadata',
      'profile.json',
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
      name: string;
      schemaVersion: number;
      vscodeCli: { command: string; version: string; executablePath: string };
    };

    expect(manifest.name).toBe('with-metadata');
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.vscodeCli).toEqual(expect.objectContaining({
      command: 'code.cmd',
      version: '1.121.0',
      executablePath: 'C:\\VS Code\\Code.exe',
    }));
  });

  it('stores profiles relative to the extension path when provided', () => {
    const extensionRoot = path.join(tempDir, 'extension-root');
    fs.mkdirSync(extensionRoot, { recursive: true });

    openProfile('scoped', extensionRoot);

    expect(fs.existsSync(path.join(
      extensionRoot,
      'tests',
      'vscode-extension-tester',
      'profiles',
      'scoped',
      'profile.json',
    ))).toBe(true);
    expect(fs.existsSync(path.join(
      tempDir,
      'tests',
      'vscode-extension-tester',
      'profiles',
      'scoped',
    ))).toBe(false);
    expect(mockBuildExtension).toHaveBeenCalledWith(extensionRoot);
  });
});