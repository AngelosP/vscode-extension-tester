import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunOptions, TestRunResult } from '../types.js';
import { CONTROLLER_WS_PORT, STEP_TIMEOUT_MS, DEFAULT_FEATURES_DIR } from '../types.js';
import { devMode } from '../modes/dev-mode.js';
import { ciMode } from '../modes/ci-mode.js';
import { printResults, writeReportFile, writeRunArtifacts } from '../utils/reporter.js';
import { ControllerClient } from '../runner/controller-client.js';
import { runFeatures } from '../modes/dev-mode.js';

export async function runCommand(opts: Record<string, string | boolean>): Promise<void> {
  const options: RunOptions = {
    ci: opts['ci'] === true,
    waitForDevhost: opts['waitForDevhost'] === true,
    extensionPath: String(opts['extensionPath'] ?? '.'),
    features: String(opts['features'] ?? DEFAULT_FEATURES_DIR),
    vscodeVersion: String(opts['vscodeVersion'] ?? 'stable'),
    record: opts['record'] === true,
    recordOnFailure: opts['recordOnFailure'] === true,
    reporter: (opts['reporter'] as RunOptions['reporter']) ?? 'console',
    port: parseInt(String(opts['port'] ?? CONTROLLER_WS_PORT), 10),
    xvfb: opts['xvfb'] === true,
    timeout: parseInt(String(opts['timeout'] ?? STEP_TIMEOUT_MS), 10),
    runId: opts['runId'] ? String(opts['runId']) : undefined,
  };

  try {
    if (options.runId) {
      await runWithId(options);
    } else {
      await runDefault(options);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nError: ${message}\n`);
    process.exit(1);
  }
}

/** Standard run (no --run-id). */
async function runDefault(options: RunOptions): Promise<void> {
  const result = options.ci
    ? await ciMode(options)
    : await devMode(options);

  printResults(result, options.reporter);

  const reportPath = writeReportFile(result, options.extensionPath);
  console.log(`Report written to: ${reportPath}\n`);

  process.exit(result.totalFailed > 0 ? 1 : 0);
}

/**
 * Run-ID mode. Assumes the Dev Host is already running (user launched it via F5
 * using the launch config we created during init). Connects, runs tests, writes artifacts.
 */
async function runWithId(options: RunOptions): Promise<void> {
  const runId = options.runId!;
  const cwd = path.resolve(options.extensionPath);
  const featuresDir = path.join(cwd, 'tests', 'vscode-extension-tester', 'e2e', runId);
  const runDir = path.join(cwd, 'tests', 'vscode-extension-tester', 'runs', runId);

  // 1. Locate feature files in e2e/<run-id>/
  if (!fs.existsSync(featuresDir)) {
    throw new Error(`Features directory not found: ${featuresDir}\nCreate .feature files in tests/vscode-extension-tester/e2e/${runId}/`);
  }
  const featureFiles = fs.readdirSync(featuresDir).filter((f) => f.endsWith('.feature'));
  if (featureFiles.length === 0) {
    throw new Error(`No .feature files in ${featuresDir}`);
  }

  // Ensure artifacts directory exists
  fs.mkdirSync(runDir, { recursive: true });

  // 2. Connect to the controller — poll up to 60s so the agent can start the
  //    debug session and we wait for the Dev Host to come up.
  const client = new ControllerClient(options.port);
  console.log('Waiting for Dev Host controller...');
  let connected = false;
  for (let i = 0; i < 60; i++) {
    try {
      await client.connect();
      connected = true;
      break;
    } catch {
      await delay(1000);
    }
  }
  if (!connected) {
    throw new Error(
      'Could not connect to the Dev Host controller within 60s.\n' +
      'Make sure the debug session "Debug extension with automation support" is running.'
    );
  }
  console.log('Connected to Dev Host.\n');

  let result: TestRunResult;
  try {
    await client.ping();

    const runOptions: RunOptions = { ...options, features: path.relative(cwd, featuresDir) };
    result = await runFeatures(client, runOptions, Date.now(), runDir);

    printResults(result, options.reporter);
  } finally {
    client.disconnect();
  }

  // 3. Write artifacts
  writeRunArtifacts(result, cwd, runId, featureFiles, '');

  console.log(`\nArtifacts written to: ${path.relative(cwd, runDir)}/\n`);

  process.exit(result.totalFailed > 0 ? 1 : 0);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
