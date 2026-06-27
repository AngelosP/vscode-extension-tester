import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IterationMetadata, IterationResult, JsonCollectorSpec, RunOptions, TestRunResult, RunMetadata, StepArtifact } from '../types.js';
import { CONTROLLER_WS_PORT, CDP_PORT, STEP_TIMEOUT_MS, DEFAULT_FEATURES_DIR } from '../types.js';
import { launchMode } from '../modes/ci-mode.js';
import { attachMode } from '../modes/dev-mode.js';
import { printResults, writeReportFile, writeRunArtifacts, toFileTimestamp } from '../utils/reporter.js';
import { getEffectiveProfileName, profileExists, validateProfileOptions } from '../profile.js';
import { buildExtension } from '../build.js';
import { buildPerfSummary, writePerfSummary } from '../utils/perf-summary.js';

export async function runCommand(opts: Record<string, string | boolean | string[]>): Promise<void> {
  try {
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
      perf: opts['perf'] === true,
      iterations: parseNonNegativeInteger(opts['iterations'], '--iterations', 1),
      warmup: parseNonNegativeInteger(opts['warmup'], '--warmup', 0),
      env: parseEnvOptions(asStringArray(opts['env'])),
      vscodeArgs: asStringArray(opts['vscodeArg']),
      jsonCollectors: [
        ...parseCollectorOptions(asStringArray(opts['collectWebviewJson']), 'webview'),
        ...parseCollectorOptions(asStringArray(opts['collectExtensionHostJson']), 'extension-host'),
      ],
      reuseNamedProfile: opts['reuseNamedProfile'] ? String(opts['reuseNamedProfile']) : undefined,
      reuseOrCreateNamedProfile: opts['reuseOrCreateNamedProfile'] ? String(opts['reuseOrCreateNamedProfile']) : undefined,
      cloneNamedProfile: opts['cloneNamedProfile'] ? String(opts['cloneNamedProfile']) : undefined,
      autoReset: opts['autoReset'] === true,
      parallel: opts['parallel'] === true,
      maxWorkers: opts['maxWorkers'] ? parseInt(String(opts['maxWorkers']), 10) : undefined,
      build: opts['build'] !== false,
      paused: opts['paused'] === true,
    };

    const cwd = path.resolve(options.extensionPath);
    const explicitProfile = getEffectiveProfileName(options);
    if (!options.attachDevhost && options.testId && !explicitProfile && profileExists('default', cwd)) {
      options.reuseNamedProfile = 'default';
      console.log('Using existing named profile "default" for e2e/default test selection.');
    }

    // ─── Validate flag combinations ───
    validateFlags(options, cwd);

    // ─── Resolve paths ───
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

    const effectiveOptions = normalizeAttachLaunchOptions(options);

    // Override options.features so runFeatures resolves the correct directory
    const runOptions: RunOptions = {
      ...effectiveOptions,
      features: path.relative(cwd, featuresDir),
    };

    // ─── Build ───
    if (effectiveOptions.build) {
      buildExtension(cwd);
    }

    // ─── Execute ───
    let result: TestRunResult;
    const shouldUseIterationMode = (effectiveOptions.warmup ?? 0) > 0 || (effectiveOptions.iterations ?? 1) > 1 || effectiveOptions.perf === true;
    if (shouldUseIterationMode) {
      result = await runIterations(runOptions, runDir);
    } else {
      result = await executeSingleRun(runOptions, runDir, undefined);
    }

    // ─── Report ───
    const metadata: RunMetadata = {
      timestamp,
      cliCommand: process.argv.join(' '),
      entryPoint: 'vscode-ext-test run',
      cwd,
      options: {
        attachDevhost: effectiveOptions.attachDevhost,
        extensionPath: effectiveOptions.extensionPath,
        features: effectiveOptions.features,
        testId: effectiveOptions.testId,
        vscodeVersion: effectiveOptions.vscodeVersion,
        reporter: effectiveOptions.reporter,
        timeout: effectiveOptions.timeout,
        perf: effectiveOptions.perf,
        iterations: effectiveOptions.iterations,
        warmup: effectiveOptions.warmup,
        env: Object.keys(effectiveOptions.env ?? {}),
        vscodeArgs: effectiveOptions.vscodeArgs,
        jsonCollectors: effectiveOptions.jsonCollectors?.map((collector) => ({ name: collector.name, source: collector.source })),
        record: effectiveOptions.record,
        recordOnFailure: effectiveOptions.recordOnFailure,
        build: effectiveOptions.build,
        paused: effectiveOptions.paused,
      },
    };

    if (effectiveOptions.perf && result.iterations) {
      const summary = buildPerfSummary(result.iterations, metadata);
      const paths = writePerfSummary(runDir, summary);
      result = {
        ...result,
        artifacts: [
          ...(result.artifacts ?? []),
          { kind: 'perf-summary', name: 'perf-summary', source: 'runner', path: paths.jsonPath, label: 'Performance summary JSON' },
          { kind: 'perf-summary', name: 'perf-summary', source: 'runner', path: paths.markdownPath, label: 'Performance summary Markdown' },
        ],
      };
    }

    printResults(result, effectiveOptions.reporter);
    writeReportFile(result, effectiveOptions.extensionPath, metadata);
    writeRunArtifacts(result, cwd, artifactRunId, featureFiles, '', metadata);

    console.log(`\nArtifacts written to: ${path.relative(cwd, runDir)}/\n`);

    process.exit(result.totalFailed > 0 ? 1 : 0);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nError: ${message}\n`);
    process.exit(1);
  }
}

function normalizeAttachLaunchOptions(options: RunOptions): RunOptions {
  if (!options.attachDevhost) return options;
  const hasEnv = Object.keys(options.env ?? {}).length > 0;
  const hasVsCodeArgs = (options.vscodeArgs ?? []).length > 0;
  if (hasEnv) {
    console.warn('--env is ignored in --attach-devhost mode because the Dev Host is already running.');
  }
  if (hasVsCodeArgs) {
    console.warn('--vscode-arg is ignored in --attach-devhost mode because the Dev Host is already running.');
  }
  if (!hasEnv && !hasVsCodeArgs) return options;
  return { ...options, env: {}, vscodeArgs: [] };
}

async function executeSingleRun(
  options: RunOptions,
  artifactsDir: string,
  iteration?: IterationMetadata,
): Promise<TestRunResult> {
  const runnerOptions = {
    iteration,
    jsonCollectors: options.jsonCollectors,
  };
  if (options.attachDevhost) {
    return attachMode(options, artifactsDir, runnerOptions);
  }
  return launchMode(options, artifactsDir, runnerOptions);
}

async function runIterations(options: RunOptions, runDir: string): Promise<TestRunResult> {
  const warmupCount = options.warmup ?? 0;
  const measuredCount = options.iterations ?? 1;
  const iterations: IterationResult[] = [];
  const started = Date.now();
  const totalCount = warmupCount + measuredCount;

  for (let ordinal = 1; ordinal <= totalCount; ordinal++) {
    const isWarmup = ordinal <= warmupCount;
    const index = isWarmup ? ordinal : ordinal - warmupCount;
    const label = `${isWarmup ? 'warmup' : 'iteration'}-${String(index).padStart(3, '0')}`;
    const artifactsDir = path.join(runDir, label);
    fs.mkdirSync(artifactsDir, { recursive: true });

    console.log(`\nRunning ${isWarmup ? 'warmup' : 'measured'} iteration ${index}${isWarmup ? '' : ` of ${measuredCount}`}...\n`);
    const iteration: IterationMetadata = {
      phase: isWarmup ? 'warmup' : 'measured',
      index,
      label,
      artifactsDir,
    };
    const iterationOptions: RunOptions = {
      ...options,
      build: options.build && ordinal === 1,
      env: options.attachDevhost ? {} : options.env,
      vscodeArgs: options.attachDevhost ? [] : options.vscodeArgs,
    };

    const result = await executeSingleRun(iterationOptions, artifactsDir, iteration);
    iterations.push({
      ...prefixFeatureNames(result, label),
      phase: iteration.phase,
      index,
      label,
      artifactsDir,
    });
  }

  return aggregateIterations(iterations, Date.now() - started);
}

function aggregateIterations(iterations: IterationResult[], durationMs: number): TestRunResult {
  const features = iterations.flatMap((iteration) => iteration.features);
  return {
    features,
    totalPassed: iterations.reduce((sum, iteration) => sum + iteration.totalPassed, 0),
    totalFailed: iterations.reduce((sum, iteration) => sum + iteration.totalFailed, 0),
    totalSkipped: iterations.reduce((sum, iteration) => sum + iteration.totalSkipped, 0),
    durationMs,
    iterations,
  };
}

function prefixFeatureNames(result: TestRunResult, label: string): TestRunResult {
  return {
    ...result,
    features: result.features.map((feature) => ({
      ...feature,
      name: `[${label}] ${feature.name}`,
      scenarios: feature.scenarios.map((scenario) => ({
        ...scenario,
        name: `[${label}] ${scenario.name}`,
      })),
    })),
  };
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

  if ((options.iterations ?? 1) < 1) {
    throw new Error('--iterations must be at least 1.');
  }

  if ((options.warmup ?? 0) < 0) {
    throw new Error('--warmup must be 0 or greater.');
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

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (value === undefined) return [];
  return [String(value)];
}

function parseNonNegativeInteger(value: unknown, name: string, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} is too large.`);
  }
  return parsed;
}

function parseEnvOptions(values: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator <= 0) {
      throw new Error(`--env must be in KEY=VALUE form. Got: ${value}`);
    }
    const key = value.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid --env key: ${key}`);
    }
    if (key.toUpperCase() === 'VSCODE_EXT_TESTER_PORT') {
      throw new Error('VSCODE_EXT_TESTER_PORT is managed by vscode-ext-test and cannot be set via --env.');
    }
    env[key] = value.slice(separator + 1);
  }
  return env;
}

function parseCollectorOptions(values: string[], source: JsonCollectorSpec['source']): JsonCollectorSpec[] {
  return values.map((value, index) => {
    const separator = value.indexOf('=');
    if (separator > 0) {
      const maybeName = value.slice(0, separator);
      if (/^[A-Za-z0-9_-]+$/.test(maybeName)) {
        return { name: maybeName, source, expression: value.slice(separator + 1) };
      }
    }
    return {
      name: `${source === 'webview' ? 'webview-json' : 'extension-host-json'}-${index + 1}`,
      source,
      expression: value,
    };
  });
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


