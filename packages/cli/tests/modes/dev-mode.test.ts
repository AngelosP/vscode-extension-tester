import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunOptions } from '../../src/types.js';

const { mockDetectDevHost, mockRunnerCtorArgs } = vi.hoisted(() => ({
  mockDetectDevHost: vi.fn(),
  mockRunnerCtorArgs: [] as unknown[][],
}));

vi.mock('../../src/utils/dev-host-detector.js', () => ({
  detectDevHost: mockDetectDevHost,
}));

vi.mock('../../src/runner/controller-client.js', () => ({
  ControllerClient: class MockControllerClient {
    constructor(readonly port: number) {}
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn();
    ping = vi.fn().mockResolvedValue({ ok: true });
    executeCommand = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../../src/runner/gherkin-parser.js', () => ({
  GherkinParser: class MockGherkinParser {
    parseFile = vi.fn().mockResolvedValue({
      name: 'Feature',
      description: '',
      tags: [],
      backgroundSteps: [],
      scenarios: [],
      uri: 'test.feature',
    });
  },
}));

vi.mock('../../src/runner/test-runner.js', () => ({
  TestRunner: class MockTestRunner {
    constructor(...args: unknown[]) {
      mockRunnerCtorArgs.push(args);
    }
    runFeature = vi.fn().mockResolvedValue({
      name: 'Feature',
      description: '',
      scenarios: [],
      passed: 0,
      failed: 0,
      skipped: 0,
      durationMs: 1,
    });
    cleanup = vi.fn();
  },
}));

const { attachMode } = await import('../../src/modes/dev-mode.js');

function makeOptions(extensionPath: string): RunOptions {
  return {
    attachDevhost: true,
    extensionPath,
    features: 'features',
    vscodeVersion: 'stable',
    xvfb: false,
    controllerPort: 9788,
    cdpPort: 9333,
    record: false,
    recordOnFailure: false,
    reporter: 'console',
    timeout: 30_000,
    build: false,
    paused: false,
    autoReset: true,
    parallel: false,
  };
}

describe('attachMode', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-ext-test-'));
    fs.mkdirSync(path.join(tempDir, 'features'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'features', 'test.feature'), 'Feature: test\n');
    mockDetectDevHost.mockResolvedValue({ pid: 4242, commandLine: 'Code - Extension Development Host' });
    mockRunnerCtorArgs.length = 0;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('passes attach-mode CDP port and Dev Host PID into TestRunner', async () => {
    await attachMode(makeOptions(tempDir));

    expect(mockDetectDevHost).toHaveBeenCalledWith(tempDir);
    expect(mockRunnerCtorArgs).toHaveLength(1);
    expect(mockRunnerCtorArgs[0][4]).toBe(9333);
    expect(mockRunnerCtorArgs[0][5]).toBe(4242);
  });
});
