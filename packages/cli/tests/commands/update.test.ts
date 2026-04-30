import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { mockResolveVSCodeCli, mockExecVSCodeCliSync } = vi.hoisted(() => ({
  mockResolveVSCodeCli: vi.fn(),
  mockExecVSCodeCliSync: vi.fn(),
}));

vi.mock('../../src/utils/vscode-cli.js', () => ({
  resolveVSCodeCli: mockResolveVSCodeCli,
  execVSCodeCliSync: mockExecVSCodeCliSync,
  formatVSCodeCliMissingMessage: () => 'VS Code CLI not found.',
}));

const { updateCommand } = await import('../../src/commands/update.js');

const CONTROLLER_FOLDER = 'vscode-extension-tester.vscode-extension-tester-controller-0.1.0';

describe('updateCommand', () => {
  let originalCwd: string;
  let tempDir: string;
  let extensionsDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-ext-test-update-'));
    process.chdir(tempDir);
    process.exitCode = undefined;

    extensionsDir = path.join(
      tempDir,
      'tests',
      'vscode-extension-tester',
      'profiles',
      'profile-one',
      'extensions',
    );
    fs.mkdirSync(path.join(tempDir, 'tests', 'vscode-extension-tester', 'profiles', 'profile-one', 'user-data'), { recursive: true });
    fs.mkdirSync(path.join(extensionsDir, CONTROLLER_FOLDER), { recursive: true });
    fs.writeFileSync(path.join(extensionsDir, CONTROLLER_FOLDER, 'sentinel.txt'), 'old', 'utf-8');
    fs.writeFileSync(path.join(extensionsDir, CONTROLLER_FOLDER, 'package.json'), JSON.stringify({ publisher: 'vscode-extension-tester', name: 'vscode-extension-tester-controller' }), 'utf-8');
    fs.writeFileSync(path.join(extensionsDir, 'extensions.json'), '[{"identifier":{"id":"old"}}]', 'utf-8');

    mockResolveVSCodeCli.mockReset();
    mockExecVSCodeCliSync.mockReset();
    mockResolveVSCodeCli.mockReturnValue({
      command: 'code.cmd',
      displayName: 'VS Code',
      source: 'path',
      variant: 'stable',
      requiresShell: true,
    });

    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = undefined;
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('restores the previous profile controller folder when replacement reinstall fails', async () => {
    let realProfileInstallCount = 0;
    mockExecVSCodeCliSync.mockImplementation((_cli, args: string[]) => {
      if (args.includes('--extensions-dir')) {
        const extensionsDirArg = args[args.indexOf('--extensions-dir') + 1];
        if (extensionsDirArg.includes('.controller-probe-')) {
          createControllerManifest(extensionsDirArg, CONTROLLER_FOLDER);
          return '';
        }

        realProfileInstallCount++;
        if (realProfileInstallCount === 1) {
          fs.mkdirSync(path.join(extensionsDirArg, 'vscode-extension-tester.vscode-extension-tester-controller-0.2.0'), { recursive: true });
          fs.writeFileSync(path.join(extensionsDirArg, 'extensions.json'), '[{"identifier":{"id":"new"}}]', 'utf-8');
          throw new Error('replacement failed');
        }
      }
      return '';
    });

    await updateCommand();

    const restoredSentinel = path.join(extensionsDir, CONTROLLER_FOLDER, 'sentinel.txt');
    expect(fs.existsSync(restoredSentinel)).toBe(true);
    expect(fs.readFileSync(restoredSentinel, 'utf-8')).toBe('old');
    expect(fs.existsSync(path.join(extensionsDir, 'vscode-extension-tester.vscode-extension-tester-controller-0.2.0'))).toBe(false);
    expect(fs.readFileSync(path.join(extensionsDir, 'extensions.json'), 'utf-8')).toBe('[{"identifier":{"id":"old"}}]');
    expect(process.exitCode).toBe(1);
    expect(fs.readdirSync(path.dirname(extensionsDir)).some((entry) => entry.startsWith('.controller-backup-'))).toBe(false);
    expect(fs.readdirSync(path.dirname(extensionsDir)).some((entry) => entry.startsWith('.controller-probe-'))).toBe(false);
  });

  it('returns non-zero when the global install fails', async () => {
    fs.rmSync(path.join(tempDir, 'tests', 'vscode-extension-tester', 'profiles'), { recursive: true, force: true });
    mockExecVSCodeCliSync.mockImplementation((_cli, args: string[]) => {
      if (!args.includes('--extensions-dir')) {
        throw new Error('global failed');
      }
      return '';
    });

    await updateCommand();

    expect(process.exitCode).toBe(1);
  });

  it('cleans up backup directories when extensions metadata cannot be copied', async () => {
    fs.rmSync(path.join(extensionsDir, 'extensions.json'), { force: true });
    fs.mkdirSync(path.join(extensionsDir, 'extensions.json'));

    mockExecVSCodeCliSync.mockImplementation((_cli, args: string[]) => {
      if (args.includes('--extensions-dir')) {
        const extensionsDirArg = args[args.indexOf('--extensions-dir') + 1];
        if (extensionsDirArg.includes('.controller-probe-')) {
          createControllerManifest(extensionsDirArg, CONTROLLER_FOLDER);
          return '';
        }
      }
      return '';
    });

    await updateCommand();

    expect(fs.existsSync(path.join(extensionsDir, CONTROLLER_FOLDER, 'sentinel.txt'))).toBe(true);
    expect(fs.readdirSync(path.dirname(extensionsDir)).some((entry) => entry.startsWith('.controller-backup-'))).toBe(false);
    expect(fs.readdirSync(path.dirname(extensionsDir)).some((entry) => entry.startsWith('.controller-probe-'))).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('creates a missing profile extensions directory and installs into it', async () => {
    fs.rmSync(extensionsDir, { recursive: true, force: true });

    const installedFolder = 'vscode-extension-tester.vscode-extension-tester-controller-0.2.0';
    mockExecVSCodeCliSync.mockImplementation((_cli, args: string[]) => {
      if (args.includes('--extensions-dir')) {
        const extensionsDirArg = args[args.indexOf('--extensions-dir') + 1];
        if (extensionsDirArg.includes('.controller-probe-')) {
          createControllerManifest(extensionsDirArg, CONTROLLER_FOLDER);
          return '';
        }
        createControllerManifest(extensionsDirArg, installedFolder);
      }
      return '';
    });

    await updateCommand();

    expect(fs.existsSync(path.join(extensionsDir, installedFolder, 'package.json'))).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('uses profile user data and removes stale controller metadata before profile reinstall', async () => {
    const userDataDir = path.join(tempDir, 'tests', 'vscode-extension-tester', 'profiles', 'profile-one', 'user-data');
    const installedFolder = 'vscode-extension-tester.vscode-extension-tester-controller-0.2.0';
    fs.writeFileSync(path.join(extensionsDir, 'extensions.json'), JSON.stringify([
      { identifier: { id: 'vscode-extension-tester.vscode-extension-tester-controller' }, relativeLocation: CONTROLLER_FOLDER },
      { identifier: { id: 'publisher.other-extension' }, relativeLocation: 'publisher.other-extension-1.0.0' },
    ]), 'utf-8');

    let realProfileInstallSawCleanMetadata = false;
    mockExecVSCodeCliSync.mockImplementation((_cli, args: string[]) => {
      if (args.includes('--extensions-dir')) {
        const extensionsDirArg = args[args.indexOf('--extensions-dir') + 1];
        const userDataDirArg = args[args.indexOf('--user-data-dir') + 1];
        if (extensionsDirArg.includes('.controller-probe-')) {
          expect(userDataDirArg).toContain('.controller-probe-');
          createControllerManifest(extensionsDirArg, CONTROLLER_FOLDER);
          return '';
        }

        expect(userDataDirArg).toBe(userDataDir);
        const metadataBeforeInstall = JSON.parse(fs.readFileSync(path.join(extensionsDirArg, 'extensions.json'), 'utf-8')) as Array<{ relativeLocation?: string }>;
        expect(metadataBeforeInstall.map((entry) => entry.relativeLocation)).toEqual(['publisher.other-extension-1.0.0']);
        realProfileInstallSawCleanMetadata = true;
        createControllerManifest(extensionsDirArg, installedFolder);
      }
      return '';
    });

    await updateCommand();

    expect(realProfileInstallSawCleanMetadata).toBe(true);
    expect(fs.existsSync(path.join(extensionsDir, installedFolder, 'package.json'))).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('removes partial controller files when a first profile install fails', async () => {
    fs.rmSync(path.join(extensionsDir, CONTROLLER_FOLDER), { recursive: true, force: true });

    mockExecVSCodeCliSync.mockImplementation((_cli, args: string[]) => {
      if (args.includes('--extensions-dir')) {
        const extensionsDirArg = args[args.indexOf('--extensions-dir') + 1];
        if (extensionsDirArg.includes('.controller-probe-')) {
          createControllerManifest(extensionsDirArg, CONTROLLER_FOLDER);
          return '';
        }

        fs.mkdirSync(path.join(extensionsDirArg, 'vscode-extension-tester.vscode-extension-tester-controller-0.2.0'), { recursive: true });
        fs.writeFileSync(path.join(extensionsDirArg, 'extensions.json'), '[{"identifier":{"id":"new"}}]', 'utf-8');
        throw new Error('first install failed');
      }
      return '';
    });

    await updateCommand();

    expect(fs.existsSync(path.join(extensionsDir, CONTROLLER_FOLDER))).toBe(false);
    expect(fs.existsSync(path.join(extensionsDir, 'vscode-extension-tester.vscode-extension-tester-controller-0.2.0'))).toBe(false);
    expect(fs.readFileSync(path.join(extensionsDir, 'extensions.json'), 'utf-8')).toBe('[{"identifier":{"id":"old"}}]');
    expect(fs.readdirSync(path.dirname(extensionsDir)).some((entry) => entry.startsWith('.controller-backup-'))).toBe(false);
    expect(fs.readdirSync(path.dirname(extensionsDir)).some((entry) => entry.startsWith('.controller-probe-'))).toBe(false);
  });

  it('returns non-zero when VS Code CLI is missing', async () => {
    mockResolveVSCodeCli.mockReturnValue(null);

    await updateCommand();

    expect(process.exitCode).toBe(1);
    expect(mockExecVSCodeCliSync).not.toHaveBeenCalled();
  });

  it('rolls back when an install exits successfully but leaves an unusable controller folder', async () => {
    fs.rmSync(path.join(extensionsDir, CONTROLLER_FOLDER), { recursive: true, force: true });

    mockExecVSCodeCliSync.mockImplementation((_cli, args: string[]) => {
      if (args.includes('--extensions-dir')) {
        const extensionsDirArg = args[args.indexOf('--extensions-dir') + 1];
        if (extensionsDirArg.includes('.controller-probe-')) {
          createControllerManifest(extensionsDirArg, CONTROLLER_FOLDER);
          return '';
        }

        fs.mkdirSync(path.join(extensionsDirArg, 'vscode-extension-tester.vscode-extension-tester-controller-0.2.0'), { recursive: true });
        fs.writeFileSync(path.join(extensionsDirArg, 'extensions.json'), '[{"identifier":{"id":"new"}}]', 'utf-8');
      }
      return '';
    });

    await updateCommand();

    expect(fs.existsSync(path.join(extensionsDir, 'vscode-extension-tester.vscode-extension-tester-controller-0.2.0'))).toBe(false);
    expect(fs.readFileSync(path.join(extensionsDir, 'extensions.json'), 'utf-8')).toBe('[{"identifier":{"id":"old"}}]');
    expect(process.exitCode).toBe(1);
  });

  it('backs up manifest-identified controller directories that do not use the controller prefix', async () => {
    fs.rmSync(path.join(extensionsDir, CONTROLLER_FOLDER), { recursive: true, force: true });
    createControllerManifest(extensionsDir, '_controller');

    mockExecVSCodeCliSync.mockImplementation((_cli, args: string[]) => {
      if (args.includes('--extensions-dir')) {
        const extensionsDirArg = args[args.indexOf('--extensions-dir') + 1];
        if (extensionsDirArg.includes('.controller-probe-')) {
          createControllerManifest(extensionsDirArg, CONTROLLER_FOLDER);
          return '';
        }

        fs.mkdirSync(path.join(extensionsDirArg, 'vscode-extension-tester.vscode-extension-tester-controller-0.2.0'), { recursive: true });
        throw new Error('replacement failed');
      }
      return '';
    });

    await updateCommand();

    expect(fs.existsSync(path.join(extensionsDir, '_controller', 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(extensionsDir, 'vscode-extension-tester.vscode-extension-tester-controller-0.2.0'))).toBe(false);
  });

  it('removes stale controller metadata after a successful profile replacement', async () => {
    fs.rmSync(path.join(extensionsDir, CONTROLLER_FOLDER), { recursive: true, force: true });
    createControllerManifest(extensionsDir, '_controller');
    const oldTarget = path.join(tempDir, 'tests', 'vscode-extension-tester', 'profiles', 'profile-one', 'user-data', '_controller-dev');
    fs.mkdirSync(oldTarget, { recursive: true });
    fs.writeFileSync(path.join(extensionsDir, 'extensions.json'), JSON.stringify([
      { identifier: { id: 'vscode-extension-tester.vscode-extension-tester-controller' }, relativeLocation: '_controller', location: { fsPath: oldTarget } },
    ]), 'utf-8');

    const newControllerFolder = 'vscode-extension-tester.vscode-extension-tester-controller-0.2.0';
    mockExecVSCodeCliSync.mockImplementation((_cli, args: string[]) => {
      if (args.includes('--extensions-dir')) {
        const extensionsDirArg = args[args.indexOf('--extensions-dir') + 1];
        if (extensionsDirArg.includes('.controller-probe-')) {
          createControllerManifest(extensionsDirArg, CONTROLLER_FOLDER);
          return '';
        }

        createControllerManifest(extensionsDirArg, newControllerFolder);
        fs.writeFileSync(path.join(extensionsDirArg, 'extensions.json'), JSON.stringify([
          { identifier: { id: 'vscode-extension-tester.vscode-extension-tester-controller' }, relativeLocation: '_controller', location: { fsPath: oldTarget } },
          { identifier: { id: 'vscode-extension-tester.vscode-extension-tester-controller' }, relativeLocation: newControllerFolder },
        ]), 'utf-8');
      }
      return '';
    });

    await updateCommand();

    const metadata = JSON.parse(fs.readFileSync(path.join(extensionsDir, 'extensions.json'), 'utf-8')) as Array<{ relativeLocation?: string }>;
    expect(metadata.map((entry) => entry.relativeLocation)).toEqual([newControllerFolder]);
    expect(process.exitCode).toBeUndefined();
  });
});

function createControllerManifest(extensionsDir: string, folder: string): void {
  const folderPath = path.join(extensionsDir, folder);
  fs.mkdirSync(folderPath, { recursive: true });
  fs.writeFileSync(path.join(folderPath, 'package.json'), JSON.stringify({
    publisher: 'vscode-extension-tester',
    name: 'vscode-extension-tester-controller',
  }), 'utf-8');
}