import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { mockResolveVSCodeCli } = vi.hoisted(() => ({
  mockResolveVSCodeCli: vi.fn(),
}));

vi.mock('../src/utils/vscode-cli.js', () => ({
  resolveVSCodeCli: mockResolveVSCodeCli,
  formatVSCodeCliMissingMessage: () => 'VS Code CLI not found.',
  execVSCodeCliSync: vi.fn(),
  spawnVSCodeCli: vi.fn(),
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
});