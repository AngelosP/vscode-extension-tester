import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ControllerClient } from '../../src/runner/controller-client.js';
import type { RunOptions } from '../../src/types.js';

const mocks = vi.hoisted(() => {
  const client = {
    getState: vi.fn().mockResolvedValue({ terminals: [], notifications: [] }),
    resetState: vi.fn().mockResolvedValue(undefined),
    executeCommand: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue({ status: 'ok' }),
  };
  return {
    client,
    events: [] as string[],
    createLaunchDevHostSession: vi.fn(),
    attachDevHostSession: vi.fn(),
    runFeatures: vi.fn(),
    detectDevHost: vi.fn(),
    buildExtension: vi.fn(),
    runSingleStep: vi.fn(),
    runFeature: vi.fn(),
    captureArtifactScreenshot: vi.fn(),
    cleanup: vi.fn(),
    runnerCtorArgs: [] as unknown[][],
  };
});

vi.mock('../../src/modes/ci-mode.js', () => ({
  createLaunchDevHostSession: mocks.createLaunchDevHostSession,
}));

vi.mock('../../src/modes/dev-mode.js', () => ({
  attachDevHostSession: mocks.attachDevHostSession,
  runFeatures: mocks.runFeatures,
}));

vi.mock('../../src/utils/dev-host-detector.js', () => ({
  detectDevHost: mocks.detectDevHost,
}));

vi.mock('../../src/build.js', () => ({
  buildExtension: mocks.buildExtension,
}));

vi.mock('../../src/runner/test-runner.js', () => ({
  TestRunner: class MockTestRunner {
    constructor(...args: unknown[]) {
      mocks.runnerCtorArgs.push(args);
    }
    runSingleStep = mocks.runSingleStep;
    runFeature = mocks.runFeature;
    captureArtifactScreenshot = mocks.captureArtifactScreenshot;
    cleanup = mocks.cleanup;
  },
}));

const { LiveTestSession } = await import('../../src/runner/live-session.js');

function runOptions(): RunOptions {
  return {
    attachDevhost: false,
    extensionPath: '.',
    features: 'tests/vscode-extension-tester/e2e',
    vscodeVersion: 'stable',
    xvfb: false,
    controllerPort: 9788,
    cdpPort: 9222,
    record: false,
    recordOnFailure: false,
    reporter: 'json',
    timeout: 30000,
    build: false,
    paused: false,
    autoReset: false,
    parallel: false,
  };
}

describe('LiveTestSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
    mocks.runnerCtorArgs.length = 0;
    mocks.detectDevHost.mockResolvedValue(null);
    mocks.createLaunchDevHostSession.mockResolvedValue({
      mode: 'launch',
      client: mocks.client as unknown as ControllerClient,
      controllerPort: 19788,
      cdpPort: 19222,
      userDataDir: 'user-data',
      targetPid: 1234,
      close: vi.fn(async () => { mocks.events.push('close'); }),
    });
    mocks.attachDevHostSession.mockResolvedValue({
      mode: 'attach',
      client: mocks.client as unknown as ControllerClient,
      controllerPort: 9788,
      cdpPort: 9222,
      targetPid: 5678,
      close: vi.fn(async () => { mocks.events.push('attach-close'); }),
      reload: vi.fn().mockResolvedValue(undefined),
    });
    mocks.runSingleStep.mockResolvedValue({
      keyword: 'When ',
      text: 'I execute command "test.command"',
      status: 'passed',
      durationMs: 1,
      stepIndex: 1,
      artifacts: { screenshots: [], logs: [], warnings: [] },
    });
    mocks.captureArtifactScreenshot.mockImplementation(async () => {
      mocks.events.push('screenshot');
      return { kind: 'final-screenshot', path: 'final.png' };
    });
    mocks.cleanup.mockImplementation(() => { mocks.events.push('cleanup'); });
  });

  it('should launch in auto mode when no Dev Host is detected', async () => {
    const session = await LiveTestSession.start({ mode: 'auto', runOptions: runOptions(), finalScreenshot: true });

    expect(mocks.createLaunchDevHostSession).toHaveBeenCalled();
    expect(session.getSummary().mode).toBe('launch');
    expect(session.getSummary().cdpPort).toBe(19222);
  });

  it('should run inline steps serially through the test runner', async () => {
    const session = await LiveTestSession.start({ mode: 'launch', runOptions: runOptions(), finalScreenshot: false });

    const result = await session.runStep('When I execute command "test.command"');

    expect(result.status).toBe('passed');
    expect(mocks.runSingleStep).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'I execute command "test.command"' }),
      expect.objectContaining({ stepIndex: 1, screenshotPolicy: 'always' }),
    );
    expect(session.getSummary().stepsRun).toBe(1);
  });

  it('should capture final screenshot before closing a launched session', async () => {
    const session = await LiveTestSession.start({ mode: 'launch', runOptions: runOptions(), finalScreenshot: true });

    await session.close();

    expect(mocks.events).toEqual(['screenshot', 'cleanup', 'close']);
    expect(session.getSummary().finalScreenshot?.kind).toBe('final-screenshot');
  });

  it('should attach in auto mode when a Dev Host is detected', async () => {
    mocks.detectDevHost.mockResolvedValue({ pid: 5678, extensionPath: '.', cdpPort: 9222 });

    const session = await LiveTestSession.start({ mode: 'auto', runOptions: runOptions(), finalScreenshot: false });

    expect(mocks.attachDevHostSession).toHaveBeenCalled();
    expect(session.getSummary().mode).toBe('attach');
    await session.close();
    expect(mocks.events).toEqual(['cleanup', 'attach-close']);
  });

  it('should clean up the old runner before replacing it on reload reset', async () => {
    const session = await LiveTestSession.start({ mode: 'launch', runOptions: runOptions(), finalScreenshot: false });

    await session.reset('reload');

    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
  });

  it('should create live runners with Dev Host-window coordinate origin and step timeout', async () => {
    const session = await LiveTestSession.start({ mode: 'launch', runOptions: runOptions(), finalScreenshot: false });

    await session.reset('reload');

    expect(mocks.runnerCtorArgs).toHaveLength(2);
    expect(mocks.runnerCtorArgs[0][5]).toBe(1234);
    expect(mocks.runnerCtorArgs[0][6]).toEqual({ coordinateOrigin: 'devHostWindow', stepTimeoutMs: 30_000 });
    expect(mocks.runnerCtorArgs[1][5]).toBe(1234);
    expect(mocks.runnerCtorArgs[1][6]).toEqual({ coordinateOrigin: 'devHostWindow', stepTimeoutMs: 30_000 });
  });

  it('should run live feature files with Dev Host-window coordinate origin', async () => {
    mocks.runFeatures.mockResolvedValue({
      features: [],
      passed: 0,
      failed: 0,
      skipped: 0,
      durationMs: 1,
    });
    const session = await LiveTestSession.start({ mode: 'launch', runOptions: runOptions(), finalScreenshot: false });

    await session.runFeatures();

    expect(mocks.runFeatures).toHaveBeenCalledWith(
      mocks.client,
      expect.objectContaining({ extensionPath: '.' }),
      expect.any(Number),
      expect.any(String),
      'user-data',
      19222,
      1234,
      { coordinateOrigin: 'devHostWindow', stepTimeoutMs: 30_000 },
    );
  });
});
