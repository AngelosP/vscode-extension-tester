import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunOptions, TestRunResult } from '../types.js';
import { CONTROLLER_WS_PORT, CDP_PORT, STEP_TIMEOUT_MS, DEFAULT_FEATURES_DIR } from '../types.js';
import { launchMode } from '../modes/ci-mode.js';
import { attachMode } from '../modes/dev-mode.js';
import { printResults, writeReportFile, writeRunArtifacts } from '../utils/reporter.js';
import { profileExists, getProfileDir, getProfileUserDataDir } from '../profile.js';
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
    validateFlags(options);

    // ─── Resolve paths ───
    const cwd = path.resolve(options.extensionPath);
    const effectiveProfile = getEffectiveProfile(options);
    const { featuresDir, runDir, artifactRunId } = resolvePaths(cwd, options, effectiveProfile);

    // Verify features exist
    if (!fs.existsSync(featuresDir)) {
      throw new Error(
        `Features directory not found: ${featuresDir}\n` +
        (options.testId
          ? `Create .feature files in ${path.relative(cwd, featuresDir)}/`
          : `Run 'vscode-ext-test init' to create example tests.`)
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
    printResults(result, options.reporter);
    writeReportFile(result, options.extensionPath);
    writeRunArtifacts(result, cwd, artifactRunId, featureFiles, '');

    console.log(`\nArtifacts written to: ${path.relative(cwd, runDir)}/\n`);

    process.exit(result.totalFailed > 0 ? 1 : 0);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nError: ${message}\n`);
    process.exit(1);
  }
}

// ─── Flag validation ──────────────────────────────────────────────────────────

function validateFlags(options: RunOptions): void {
  // Profile flags are mutually exclusive
  const profileFlags = [
    options.reuseNamedProfile && '--reuse-named-profile',
    options.reuseOrCreateNamedProfile && '--reuse-or-create-named-profile',
    options.cloneNamedProfile && '--clone-named-profile',
  ].filter(Boolean);
  if (profileFlags.length > 1) {
    throw new Error(
      `Only one profile strategy can be used at a time. Got: ${profileFlags.join(', ')}`
    );
  }

  // Attach mode restrictions
  if (options.attachDevhost) {
    if (options.parallel) {
      throw new Error(
        '--parallel is not compatible with --attach-devhost.\n' +
        'Parallel execution requires isolated launch-mode workers. Remove --attach-devhost to use parallelism.'
      );
    }
    if (profileFlags.length > 0) {
      throw new Error(
        `Profile flags are not compatible with --attach-devhost.\n` +
        'In attach mode, you use the existing Dev Host session as-is. Remove --attach-devhost to use named profiles.'
      );
    }
  }

  // Parallel restrictions
  if (options.maxWorkers !== undefined && !options.parallel) {
    throw new Error('--max-workers requires --parallel.');
  }
  if (options.parallel && !options.cloneNamedProfile) {
    // Parallel with no profile is allowed (fresh ephemeral workers).
    // Parallel with in-place reuse is not.
    if (options.reuseNamedProfile || options.reuseOrCreateNamedProfile) {
      throw new Error(
        '--parallel is not compatible with in-place profile reuse.\n' +
        'Use --clone-named-profile instead so each worker gets its own isolated copy.'
      );
    }
  }

  // Profile validation
  if (options.reuseNamedProfile) {
    if (!profileExists(options.reuseNamedProfile)) {
      throw new Error(
        `Profile "${options.reuseNamedProfile}" not found.\n` +
        `Create it first with: vscode-ext-test profile open ${options.reuseNamedProfile}`
      );
    }
  }
  if (options.reuseOrCreateNamedProfile) {
    if (!profileExists(options.reuseOrCreateNamedProfile)) {
      const dir = getProfileDir(options.reuseOrCreateNamedProfile);
      const userDataDir = getProfileUserDataDir(dir);
      fs.mkdirSync(userDataDir, { recursive: true });
      console.log(`Created new profile "${options.reuseOrCreateNamedProfile}"`);
    }
  }
  if (options.cloneNamedProfile) {
    if (!profileExists(options.cloneNamedProfile)) {
      throw new Error(
        `Profile "${options.cloneNamedProfile}" not found - cannot clone a non-existent profile.\n` +
        `Create it first with: vscode-ext-test profile open ${options.cloneNamedProfile}`
      );
    }
    // Clone support is not yet implemented - the profile must exist but cloning is Phase 6
    throw new Error(
      'Clone-named-profile execution is not yet implemented.\n' +
      `The profile "${options.cloneNamedProfile}" exists, but cloned worker execution is planned for a future release.\n` +
      `For now, use --reuse-named-profile ${options.cloneNamedProfile} for serial execution.`
    );
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

function getEffectiveProfile(options: RunOptions): string {
  return options.reuseNamedProfile
    ?? options.reuseOrCreateNamedProfile
    ?? options.cloneNamedProfile
    ?? 'default';
}

function resolvePaths(
  cwd: string,
  options: RunOptions,
  effectiveProfile: string,
): { featuresDir: string; runDir: string; artifactRunId: string } {
  if (options.testId) {
    // New convention: e2e/<profile>/<test-id>/
    const featuresDir = path.join(cwd, options.features, effectiveProfile, options.testId);
    const artifactRunId = `${effectiveProfile}/${options.testId}`;
    const runDir = path.join(cwd, 'tests', 'vscode-extension-tester', 'runs', effectiveProfile, options.testId);
    return { featuresDir, runDir, artifactRunId };
  }

  // Backward-compatible: use --features directly
  const featuresDir = path.resolve(cwd, options.features);
  const artifactRunId = 'latest';
  const runDir = path.join(cwd, 'tests', 'vscode-extension-tester', 'runs', artifactRunId);
  return { featuresDir, runDir, artifactRunId };
}


