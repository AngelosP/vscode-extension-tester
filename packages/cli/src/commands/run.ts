import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunOptions, TestRunResult, RunMetadata } from '../types.js';
import { CONTROLLER_WS_PORT, CDP_PORT, STEP_TIMEOUT_MS, DEFAULT_FEATURES_DIR } from '../types.js';
import { launchMode } from '../modes/ci-mode.js';
import { attachMode } from '../modes/dev-mode.js';
import { printResults, writeReportFile, writeRunArtifacts, toFileTimestamp } from '../utils/reporter.js';
import { getEffectiveProfileName, validateProfileOptions } from '../profile.js';
import { buildExtension } from '../build.js';

export async function runCommand(opts: Record<string, string | boolean>): Promise<void> {
  const options: RunOptions = {
    attachDevhost: opts['attachDevhost'] === true,
    extensionPath: String(opts['extensionPath'] ?? '.'),
    features: String(opts['features'] ?? DEFAULT_FEATURES_DIR),
    testId: opts['testId'] ? String(opts['testId']) : undefined,
    vscodeVersion: String(opts['vscodeVersion'] ?? 'stable'),
    xvfb: opts['xvfb'] === true,
    controllerPort: parseInt(String(opts['controllerPort'] ?? CONTROLLER_WS_PORT), 10),
    cdpPort: parseInt(String(opts['cdpPort'] ?? CDP_PORT), 10),
    record: opts['record'] === true,
    recordOnFailure: opts['recordOnFailure'] === true,
    reporter: (opts['reporter'] as RunOptions['reporter']) ?? 'console',
    timeout: parseInt(String(opts['timeout'] ?? STEP_TIMEOUT_MS), 10),
    reuseNamedProfile: opts['reuseNamedProfile'] ? String(opts['reuseNamedProfile']) : undefined,
    reuseOrCreateNamedProfile: opts['reuseOrCreateNamedProfile'] ? String(opts['reuseOrCreateNamedProfile']) : undefined,
    cloneNamedProfile: opts['cloneNamedProfile'] ? String(opts['cloneNamedProfile']) : undefined,
    autoReset: opts['autoReset'] === true,
    parallel: opts['parallel'] === true,
    maxWorkers: opts['maxWorkers'] ? parseInt(String(opts['maxWorkers']), 10) : undefined,
    build: opts['build'] !== false,
    paused: opts['paused'] === true,
  };

  try {
    // ─── Validate flag combinations ───
    validateFlags(options, path.resolve(options.extensionPath));

    // ─── Resolve paths ───
    const cwd = path.resolve(options.extensionPath);
    const effectiveProfile = getEffectiveProfileName(options) ?? 'default';
    const timestamp = new Date().toISOString();
    const { featuresDir, runDir, artifactRunId } = resolvePaths(cwd, options, effectiveProfile, timestamp);

    // Verify features exist
    if (!fs.existsSync(featuresDir)) {
      throw new Error(
        `Features directory not found: ${featuresDir}\n` +
        (options.testId
          ? `Create .feature files in ${path.relative(cwd, featuresDir)}/`
          : `Run 'vscode-ext-test install-into-project' to create example tests.`)
      );
    }
    const featureFiles = fs.readdirSync(featuresDir).filter((f) => f.endsWith('.feature'));
    if (featureFiles.length === 0) {
      throw new Error(`No .feature files found in ${featuresDir}`);
    }

    // Prepare artifacts directory
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.mkdirSync(runDir, { recursive: true });

    // Override options.features so runFeatures resolves the correct directory
    const runOptions: RunOptions = {
      ...options,
      features: path.relative(cwd, featuresDir),
    };

    // ─── Build ───
    if (options.build) {
      buildExtension(cwd);
    }

    // ─── Execute ───
    let result: TestRunResult;
    if (options.attachDevhost) {
      result = await attachMode(runOptions, runDir);
    } else {
      result = await launchMode(runOptions, runDir);
    }

    // ─── Report ───
    const metadata: RunMetadata = {
      timestamp,
      cliCommand: process.argv.join(' '),
      entryPoint: 'vscode-ext-test run',
      cwd,
      options: {
        attachDevhost: options.attachDevhost,
        extensionPath: options.extensionPath,
        features: options.features,
        testId: options.testId,
        vscodeVersion: options.vscodeVersion,
        reporter: options.reporter,
        timeout: options.timeout,
        record: options.record,
        recordOnFailure: options.recordOnFailure,
        build: options.build,
        paused: options.paused,
      },
    };

    printResults(result, options.reporter);
    writeReportFile(result, options.extensionPath, metadata);
    writeRunArtifacts(result, cwd, artifactRunId, featureFiles, '', metadata);

    console.log(`\nArtifacts written to: ${path.relative(cwd, runDir)}/\n`);

    process.exit(result.totalFailed > 0 ? 1 : 0);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nError: ${message}\n`);
    process.exit(1);
  }
}

// ─── Flag validation ──────────────────────────────────────────────────────────

function validateFlags(options: RunOptions, cwd: string): void {
  validateProfileOptions(options, { cwd, log: console.log });

  // Attach mode restrictions
  if (options.attachDevhost) {
    if (options.parallel) {
      throw new Error(
        '--parallel is not compatible with --attach-devhost.\n' +
        'Parallel execution requires isolated launch-mode workers. Remove --attach-devhost to use parallelism.'
      );
    }
  }

  // Parallel restrictions
  if (options.maxWorkers !== undefined && !options.parallel) {
    throw new Error('--max-workers requires --parallel.');
  }
  // Parallel not yet implemented
  if (options.parallel) {
    throw new Error(
      'Parallel execution is not yet implemented.\n' +
      'This feature is planned. For now, run without --parallel.'
    );
  }

  // Auto-reset not yet implemented
  if (options.autoReset) {
    throw new Error(
      'Auto-reset is not yet implemented.\n' +
      'This feature is planned. For now, use @clean-start tags in your feature files (coming soon).'
    );
  }
}

// ─── Path resolution ──────────────────────────────────────────────────────────

function resolvePaths(
  cwd: string,
  options: RunOptions,
  effectiveProfile: string,
  timestamp: string,
): { featuresDir: string; runDir: string; artifactRunId: string } {
  const ts = toFileTimestamp(timestamp);

  if (options.testId) {
    // New convention: e2e/<profile>/<test-id>/
    const featuresDir = path.join(cwd, options.features, effectiveProfile, options.testId);
    const artifactRunId = `${effectiveProfile}/${options.testId}/${ts}`;
    const runDir = path.join(cwd, 'tests', 'vscode-extension-tester', 'runs', effectiveProfile, options.testId, ts);
    return { featuresDir, runDir, artifactRunId };
  }

  // Backward-compatible: use --features directly
  const featuresDir = path.resolve(cwd, options.features);
  const artifactRunId = ts;
  const runDir = path.join(cwd, 'tests', 'vscode-extension-tester', 'runs', artifactRunId);
  return { featuresDir, runDir, artifactRunId };
}


