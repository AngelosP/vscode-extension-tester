import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecFileSync, mockSpawn, mockExistsSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockSpawn: vi.fn(),
  mockExistsSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
  spawn: mockSpawn,
}));

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
}));

const {
  execVSCodeCliSync,
  formatVSCodeCliMissingMessage,
  resolveVSCodeCli,
  spawnVSCodeCli,
} = await import('../../src/utils/vscode-cli.js');

describe('vscode-cli utilities', () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockSpawn.mockReset();
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(false);
    mockSpawn.mockReturnValue({ unref: vi.fn() });
  });

  it('resolves code.cmd from PATH on Windows', () => {
    mockExecFileSync.mockReturnValue('C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd\r\n');

    const cli = resolveVSCodeCli({ platform: 'win32', env: {} });

    expect(cli).toEqual(expect.objectContaining({
      command: 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd',
      source: 'path',
      variant: 'stable',
      requiresShell: true,
    }));
    expect(mockExecFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/where\.exe$/i),
      ['code.cmd'],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
  });

  it('falls back to the standard Windows user install location', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });
    mockExistsSync.mockImplementation((filePath: string) => (
      filePath === 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd'
    ));

    const cli = resolveVSCodeCli({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
    });

    expect(cli).toEqual(expect.objectContaining({
      command: 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd',
      source: 'standard-location',
      variant: 'stable',
      requiresShell: true,
    }));
  });

  it('ignores extensionless code PATH shims and falls back to standard Windows locations', () => {
    mockExecFileSync.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'code') return 'C:\\tools\\code\n';
      throw new Error('not found');
    });
    mockExistsSync.mockImplementation((filePath: string) => (
      filePath === 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd'
    ));

    const cli = resolveVSCodeCli({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
    });

    expect(cli).toEqual(expect.objectContaining({
      command: 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd',
      source: 'standard-location',
    }));
  });

  it('uses case-insensitive environment names for standard Windows locations', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });
    mockExistsSync.mockImplementation((filePath: string) => (
      filePath === 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd'
    ));

    const cli = resolveVSCodeCli({
      platform: 'win32',
      env: { LocalAppData: 'C:\\Users\\me\\AppData\\Local' },
    });

    expect(cli).toEqual(expect.objectContaining({
      command: 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd',
      source: 'standard-location',
    }));
  });

  it('resolves a quoted env override path with spaces', () => {
    mockExistsSync.mockReturnValue(true);

    const cli = resolveVSCodeCli({
      platform: 'win32',
      env: { VSCODE_EXT_TEST_CODE: '"C:\\Custom VS Code\\bin\\code.cmd"' },
    });

    expect(cli).toEqual(expect.objectContaining({
      command: 'C:\\Custom VS Code\\bin\\code.cmd',
      source: 'env',
      requiresShell: true,
    }));
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('reads the override variable case-insensitively on Windows', () => {
    mockExistsSync.mockReturnValue(true);

    const cli = resolveVSCodeCli({
      platform: 'win32',
      env: { vscode_ext_test_code: 'C:\\Custom VS Code\\bin\\code.cmd' },
    });

    expect(cli).toEqual(expect.objectContaining({
      command: 'C:\\Custom VS Code\\bin\\code.cmd',
      source: 'env',
    }));
  });

  it('prefers a sibling Windows batch wrapper for extensionless path overrides', () => {
    mockExistsSync.mockImplementation((filePath: string) => (
      filePath === 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd'
    ));

    const cli = resolveVSCodeCli({
      platform: 'win32',
      env: { VSCODE_EXT_TEST_CODE: 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code' },
    });

    expect(cli).toEqual(expect.objectContaining({
      command: 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd',
      requiresShell: true,
    }));
  });

  it('expands Windows environment references in path-like overrides', () => {
    mockExistsSync.mockImplementation((filePath: string) => (
      filePath === 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd'
    ));

    const cli = resolveVSCodeCli({
      platform: 'win32',
      env: {
        VSCODE_EXT_TEST_CODE: '%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\bin\\code.cmd',
        LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      },
    });

    expect(cli).toEqual(expect.objectContaining({
      command: 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd',
      source: 'env',
    }));
  });

  it('expands Windows environment references case-insensitively', () => {
    mockExistsSync.mockImplementation((filePath: string) => (
      filePath === 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd'
    ));

    const cli = resolveVSCodeCli({
      platform: 'win32',
      env: {
        VSCODE_EXT_TEST_CODE: '%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\bin\\code.cmd',
        LocalAppData: 'C:\\Users\\me\\AppData\\Local',
      },
    });

    expect(cli).toEqual(expect.objectContaining({
      command: 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd',
      source: 'env',
    }));
  });

  it('resolves a command-name env override through PATH', () => {
    mockExecFileSync.mockReturnValue('C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd\n');

    const cli = resolveVSCodeCli({
      platform: 'win32',
      env: { VSCODE_EXT_TEST_CODE: 'code-insiders.cmd' },
    });

    expect(cli).toEqual(expect.objectContaining({
      command: 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd',
      source: 'env',
      variant: 'insiders',
    }));
  });

  it('prefers Windows batch wrappers when a command-name lookup returns extensionless scripts too', () => {
    mockExecFileSync.mockReturnValue([
      'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code',
      'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd',
      '',
    ].join('\n'));

    const cli = resolveVSCodeCli({
      platform: 'win32',
      env: { VSCODE_EXT_TEST_CODE: 'code' },
    });

    expect(cli).toEqual(expect.objectContaining({
      command: 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd',
      requiresShell: true,
    }));
  });

  it('uses the provided environment for PATH lookup', () => {
    const customEnv = { PATH: 'C:\\custom-bin' };
    mockExecFileSync.mockReturnValue('C:\\custom-bin\\code.cmd\n');

    resolveVSCodeCli({ platform: 'win32', env: customEnv });

    expect(mockExecFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/where\.exe$/i),
      ['code.cmd'],
      expect.objectContaining({ env: customEnv }),
    );
  });

  it('returns null and guidance when no CLI can be found', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });

    const cli = resolveVSCodeCli({ platform: 'win32', env: {} });

    expect(cli).toBeNull();
    expect(formatVSCodeCliMissingMessage('win32')).toContain('VSCODE_EXT_TEST_CODE');
  });

  it('executes VS Code CLI with argument arrays and shell only when required', () => {
    const cli = {
      command: 'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd',
      displayName: 'VS Code',
      source: 'standard-location',
      variant: 'stable',
      requiresShell: true,
    } as const;

    execVSCodeCliSync(cli, ['--install-extension', 'C:\\Path With Spaces\\controller.vsix', '--force'], {
      stdio: 'inherit',
    });

    expect(mockExecFileSync).toHaveBeenCalledWith(
      process.env.ComSpec || 'cmd.exe',
      [
        '/d',
        '/s',
        '/c',
        'call "C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd" "--install-extension" "C:\\Path With Spaces\\controller.vsix" "--force"',
      ],
      expect.objectContaining({ stdio: 'inherit', shell: false, windowsVerbatimArguments: true }),
    );
  });

  it('spawns VS Code CLI while preserving caller options', () => {
    const cli = {
      command: 'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd',
      displayName: 'VS Code',
      source: 'standard-location',
      variant: 'stable',
      requiresShell: true,
    } as const;

    spawnVSCodeCli(cli, ['--new-window'], { stdio: 'ignore', detached: true });

    expect(mockSpawn).toHaveBeenCalledWith(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', 'call "C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd" "--new-window"'],
      expect.objectContaining({ stdio: 'ignore', detached: true, shell: false, windowsVerbatimArguments: true }),
    );
  });

  it('rejects percent paths for non-VS Code batch fallback execution', () => {
    const cli = {
      command: 'C:\\Tools\\custom-wrapper.cmd',
      displayName: 'VS Code CLI',
      source: 'env',
      variant: 'custom',
      requiresShell: true,
    } as const;

    expect(() => execVSCodeCliSync(cli, ['C:\\literal %TEMP% path\\controller.vsix'])).toThrow('Cannot safely pass percent signs');
  });

  it('rejects percent command paths for non-VS Code batch fallback execution', () => {
    const cli = {
      command: 'C:\\literal %TEMP% path\\custom-wrapper.cmd',
      displayName: 'VS Code CLI',
      source: 'env',
      variant: 'custom',
      requiresShell: true,
    } as const;

    expect(() => execVSCodeCliSync(cli, ['--version'])).toThrow('Cannot safely pass percent signs');
  });
});
