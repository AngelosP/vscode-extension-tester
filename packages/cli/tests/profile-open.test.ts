import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { mockResolveVSCodeCli, mockGetVSCodeCliMetadata, mockBuildExtension, mockDownload, mockSpawn } = vi.hoisted(() => ({
  mockResolveVSCodeCli: vi.fn(),
  mockGetVSCodeCliMetadata: vi.fn(),
  mockBuildExtension: vi.fn(),
  mockDownload: vi.fn(),
  mockSpawn: vi.fn(),
}));

vi.mock('@vscode/test-electron', () => ({
  download: mockDownload,
}));

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

vi.mock('../src/utils/vscode-cli.js', () => ({
  resolveVSCodeCli: mockResolveVSCodeCli,
  getVSCodeCliMetadata: mockGetVSCodeCliMetadata,
  formatVSCodeCliMissingMessage: () => 'VS Code CLI not found.',
  execVSCodeCliSync: vi.fn(),
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
    mockBuildExtension.mockReset();
    mockDownload.mockReset();
    mockSpawn.mockReset();
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
    mockDownload.mockResolvedValue('C:\\VS Code Test\\Code.exe');
    mockSpawn.mockReturnValue({ unref: vi.fn() });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses the stable downloaded test runtime by default', async () => {
    await openProfile('stable-runtime');

    expect(mockDownload).toHaveBeenCalledWith({ version: undefined });
    expect(mockSpawn).toHaveBeenCalledWith(
      'C:\\VS Code Test\\Code.exe',
      expect.arrayContaining([
        '--new-window',
        expect.stringContaining('--user-data-dir='),
        expect.stringContaining('--extensions-dir='),
      ]),
      expect.objectContaining({ detached: true }),
    );
  });

  it('writes VS Code test runtime metadata into the profile manifest', async () => {
    await openProfile('with-metadata');

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
      storageKind: string;
      vscodeCli: { command: string; executablePath: string };
    };

    expect(manifest.name).toBe('with-metadata');
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.storageKind).toBe('legacy-user-data-dir');
    expect(manifest.vscodeCli).toEqual(expect.objectContaining({
      command: 'C:\\VS Code Test\\Code.exe',
      executablePath: 'C:\\VS Code Test\\Code.exe',
    }));
  });

  it('stores profiles relative to the extension path when provided', async () => {
    const extensionRoot = path.join(tempDir, 'extension-root');
    fs.mkdirSync(extensionRoot, { recursive: true });

    await openProfile('scoped', extensionRoot);

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
    const spawnArgs = mockSpawn.mock.calls.at(-1)?.[1] as string[];
    expect(spawnArgs).toContain(`--extensionDevelopmentPath=${extensionRoot}`);
    expect(spawnArgs).not.toContain(extensionRoot);
  });
});