import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TestRunResult } from '../../src/types.js';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    launchMode: vi.fn(),
    attachMode: vi.fn(),
    buildExtension: vi.fn(),
    printResults: vi.fn(),
    writeReportFile: vi.fn(),
    writeRunArtifacts: vi.fn(),
  },
}));

vi.mock('../../src/modes/ci-mode.js', () => ({
  launchMode: mocks.launchMode,
}));

vi.mock('../../src/modes/dev-mode.js', () => ({
  attachMode: mocks.attachMode,
}));

vi.mock('../../src/build.js', () => ({
  buildExtension: mocks.buildExtension,
}));

vi.mock('../../src/utils/reporter.js', () => ({
  printResults: mocks.printResults,
  writeReportFile: mocks.writeReportFile,
  writeRunArtifacts: mocks.writeRunArtifacts,
  toFileTimestamp: () => '20260626-120000',
}));

const { runCommand } = await import('../../src/commands/run.js');

describe('runCommand', () => {
  let tempDir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-ext-test-run-command-'));
    const featuresDir = path.join(tempDir, 'tests', 'vscode-extension-tester', 'e2e');
    fs.mkdirSync(featuresDir, { recursive: true });
    fs.writeFileSync(path.join(featuresDir, 'perf.feature'), 'Feature: Perf\n', 'utf-8');
    mocks.launchMode.mockReset().mockResolvedValue(makeResult());
    mocks.attachMode.mockReset().mockResolvedValue(makeResult());
    mocks.buildExtension.mockReset();
    mocks.printResults.mockReset();
    mocks.writeReportFile.mockReset();
    mocks.writeRunArtifacts.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      process.exitCode = typeof code === 'number' ? code : code ? Number(code) : 0;
      return undefined as never;
    }) as never);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = undefined;
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('runs warmup and measured iterations in separate artifact directories', async () => {
    await runCommand({
      extensionPath: tempDir,
      features: 'tests/vscode-extension-tester/e2e',
      warmup: '1',
      iterations: '2',
      build: false,
      reporter: 'console',
    });

    expect(mocks.launchMode).toHaveBeenCalledTimes(3);
    expect(mocks.launchMode.mock.calls[0][1]).toMatch(/warmup-001$/);
    expect(mocks.launchMode.mock.calls[1][1]).toMatch(/iteration-001$/);
    expect(mocks.launchMode.mock.calls[2][1]).toMatch(/iteration-002$/);
    expect(mocks.launchMode.mock.calls[0][2].iteration).toMatchObject({ phase: 'warmup', index: 1, label: 'warmup-001' });
    expect(mocks.launchMode.mock.calls[1][2].iteration).toMatchObject({ phase: 'measured', index: 1, label: 'iteration-001' });

    const writtenResult = mocks.writeRunArtifacts.mock.calls[0][0] as TestRunResult;
    expect(writtenResult.iterations).toHaveLength(3);
    expect(writtenResult.features[0].name).toContain('[warmup-001]');
    expect(process.exitCode).toBe(0);
  });

  it('warns and strips launch-only flags in single-run attach mode', async () => {
    await runCommand({
      attachDevhost: true,
      extensionPath: tempDir,
      features: 'tests/vscode-extension-tester/e2e',
      env: ['SHOULD_NOT_APPLY=1'],
      vscodeArg: ['--disable-gpu'],
      build: false,
      reporter: 'console',
    });

    expect(warnSpy.mock.calls.map((call) => call.join(' ')).join('\n')).toContain('--env is ignored');
    expect(warnSpy.mock.calls.map((call) => call.join(' ')).join('\n')).toContain('--vscode-arg is ignored');
    expect(mocks.attachMode).toHaveBeenCalledWith(
      expect.objectContaining({ env: {}, vscodeArgs: [] }),
      expect.any(String),
      expect.any(Object),
    );
  });

  it('rejects malformed iteration counts', async () => {
    await runCommand({
      extensionPath: tempDir,
      features: 'tests/vscode-extension-tester/e2e',
      iterations: '1.5',
      build: false,
    });

    expect(errorSpy.mock.calls.map((call) => call.join(' ')).join('\n')).toContain('--iterations must be a non-negative integer');
    expect(mocks.launchMode).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('rejects controller port env vars case-insensitively', async () => {
    await runCommand({
      extensionPath: tempDir,
      features: 'tests/vscode-extension-tester/e2e',
      env: ['vscode_ext_tester_port=1234'],
      build: false,
    });

    expect(errorSpy.mock.calls.map((call) => call.join(' ')).join('\n')).toContain('VSCODE_EXT_TESTER_PORT is managed');
    expect(mocks.launchMode).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

function makeResult(): TestRunResult {
  return {
    features: [{
      name: 'Feature',
      description: '',
      scenarios: [{ name: 'Scenario', status: 'passed', steps: [], durationMs: 1, tags: [] }],
      passed: 1,
      failed: 0,
      skipped: 0,
      durationMs: 1,
    }],
    totalPassed: 1,
    totalFailed: 0,
    totalSkipped: 0,
    durationMs: 1,
  };
}