import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunOptions } from '../../src/types.js';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    download: vi.fn(),
    spawn: vi.fn(),
    execSync: vi.fn(),
    isPortInUse: vi.fn(),
    findFreePort: vi.fn(),
    vsixPath: '',
  },
}));

vi.mock('@vscode/test-electron', () => ({
  download: mocks.download,
}));

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
  execSync: mocks.execSync,
}));

vi.mock('../../src/commands/install.js', () => ({
  getVsixPath: () => mocks.vsixPath,
}));

vi.mock('../../src/utils/port.js', () => ({
  isPortInUse: mocks.isPortInUse,
  findFreePort: mocks.findFreePort,
}));

vi.mock('../../src/runner/controller-client.js', () => ({
  ControllerClient: class MockControllerClient {
    constructor(readonly port: number) {}
    connect = vi.fn().mockResolvedValue(undefined);
    ping = vi.fn().mockResolvedValue({ status: 'ok' });
    disconnect = vi.fn();
  },
}));

const { createLaunchDevHostSession } = await import('../../src/modes/ci-mode.js');

describe('createLaunchDevHostSession', () => {
  let tempDir: string;
  let originalWorkspace: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-ext-test-ci-mode-'));
    fs.mkdirSync(path.join(tempDir, 'extension'), { recursive: true });
    mocks.vsixPath = path.join(tempDir, 'controller.vsix');
    fs.writeFileSync(mocks.vsixPath, 'fake vsix', 'utf-8');
    mocks.download.mockResolvedValue(path.join(tempDir, 'Code.exe'));
    mocks.isPortInUse.mockResolvedValue(false);
    mocks.findFreePort.mockResolvedValue(19876);
    mocks.execSync.mockImplementation((command: string) => {
      const match = command.match(/-DestinationPath '([^']+)'/) ?? command.match(/-d "([^"]+)"/);
      const extractDir = match?.[1];
      if (extractDir) {
        const extensionDir = path.join(extractDir, 'extension');
        fs.mkdirSync(extensionDir, { recursive: true });
        fs.writeFileSync(path.join(extensionDir, 'package.json'), '{}', 'utf-8');
      }
      return '';
    });
    mocks.spawn.mockImplementation(() => createMockChildProcess());
    originalWorkspace = process.env.VSCODE_EXT_TEST_WORKSPACE;
    delete process.env.VSCODE_EXT_TEST_WORKSPACE;
  });

  afterEach(() => {
    if (originalWorkspace === undefined) delete process.env.VSCODE_EXT_TEST_WORKSPACE;
    else process.env.VSCODE_EXT_TEST_WORKSPACE = originalWorkspace;
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('passes env vars and appends VS Code args to launched VS Code', async () => {
    const session = await createLaunchDevHostSession(makeOptions({ env: { PERF_MODE: '1', EMPTY_VALUE: '' }, vscodeArgs: ['--disable-gpu'] }));
    await session.close();

    const [, args, spawnOptions] = mocks.spawn.mock.calls[0];
    expect(args).toContain('--disable-gpu');
    expect(spawnOptions.env.PERF_MODE).toBe('1');
    expect(spawnOptions.env.EMPTY_VALUE).toBe('');
    expect(spawnOptions.env.VSCODE_EXT_TESTER_PORT).toBe('9788');
  });

  it('keeps the controller loadable when --disable-extensions is passed', async () => {
    const session = await createLaunchDevHostSession(makeOptions({ vscodeArgs: ['--disable-extensions'] }));
    await session.close();

    const [, args] = mocks.spawn.mock.calls[0];
    const extensionDevelopmentArgs = (args as string[]).filter((arg) => arg.startsWith('--extensionDevelopmentPath='));
    expect(extensionDevelopmentArgs).toHaveLength(2);
    expect(extensionDevelopmentArgs.some((arg) => arg.includes('_controller-dev'))).toBe(true);
  });

  it('rejects unknown remote debugging ports from user VS Code args', async () => {
    await expect(
      createLaunchDevHostSession(makeOptions({ vscodeArgs: ['--remote-debugging-port=0'] })),
    ).rejects.toThrow('must know the CDP port');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('rejects VS Code args that disable the controller extension', async () => {
    await expect(
      createLaunchDevHostSession(makeOptions({
        vscodeArgs: ['--disable-extension', 'vscode-extension-tester.vscode-extension-tester-controller'],
      })),
    ).rejects.toThrow('cannot disable the controller extension');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});

function makeOptions(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    attachDevhost: false,
    extensionPath: path.join(tempRoot(), 'extension'),
    features: 'features',
    vscodeVersion: 'stable',
    xvfb: false,
    controllerPort: 9788,
    cdpPort: 9222,
    record: false,
    recordOnFailure: false,
    reporter: 'console',
    timeout: 30_000,
    build: false,
    paused: false,
    autoReset: false,
    parallel: false,
    ...overrides,
  };
}

function tempRoot(): string {
  return mocks.vsixPath ? path.dirname(mocks.vsixPath) : os.tmpdir();
}

function createMockChildProcess(): any {
  const listeners = new Map<string, () => void>();
  let killed = false;
  const child: any = {
    pid: 4242,
    kill: vi.fn(() => {
      killed = true;
      listeners.get('exit')?.();
      return true;
    }),
    on: vi.fn((event: string, handler: () => void) => {
      listeners.set(event, handler);
      if (event === 'exit' && killed) queueMicrotask(handler);
      return child;
    }),
  };
  return child;
}