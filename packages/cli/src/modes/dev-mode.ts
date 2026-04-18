import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunOptions, TestRunResult, FeatureResult } from '../types.js';
import { VSCODE_LAUNCH_TIMEOUT_MS } from '../types.js';
import { detectDevHost } from '../utils/dev-host-detector.js';
import { ControllerClient } from '../runner/controller-client.js';
import { GherkinParser } from '../runner/gherkin-parser.js';
import { TestRunner } from '../runner/test-runner.js';

/**
 * Dev mode: connect to a running Extension Development Host and run tests.
 */
export async function devMode(options: RunOptions): Promise<TestRunResult> {
  const startTime = Date.now();

  // 1. Connect to the controller extension WebSocket
  //    In --wait-for-devhost mode (used by preLaunchTask), we skip process
  //    detection entirely and poll for the WebSocket connection directly.
  //    The controller extension starts the WS server when it activates in the
  //    Dev Host — that's the reliable signal that it's ready.
  const client = new ControllerClient(options.port);
  let connected = false;

  if (options.waitForDevhost) {
    console.log('Waiting for Extension Development Host...');
    const deadline = Date.now() + VSCODE_LAUNCH_TIMEOUT_MS;
    const maxAttempts = Math.ceil(VSCODE_LAUNCH_TIMEOUT_MS / 1000);

    for (let attempt = 0; attempt < maxAttempts && Date.now() < deadline; attempt++) {
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
        `Controller extension not reachable within ${Math.round(VSCODE_LAUNCH_TIMEOUT_MS / 1000)}s.\n` +
        'Make sure the controller extension is installed: vscode-ext-test install'
      );
    }
  } else {
    // Non-wait mode: verify Dev Host exists, then connect
    const devHost = await detectDevHost();
    if (!devHost) {
      throw new Error(
        'No Extension Development Host found.\n' +
        'Make sure you have started a debug session (F5) first.\n' +
        'Or use --wait-for-devhost to poll until one appears.'
      );
    }
    console.log(`Found Extension Development Host (PID: ${devHost.pid})`);
    console.log(`Connecting to controller on port ${options.port}...`);

    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await client.connect();
        connected = true;
        break;
      } catch {
        if (attempt < 9) await delay(1000);
      }
    }

    if (!connected) {
      throw new Error(
        `Could not connect to controller extension on port ${options.port}.\n` +
        'Make sure the controller extension is installed: vscode-ext-test install'
      );
    }
  }

  console.log('Connected to controller extension.\n');

  try {
    // 3. Verify connection
    await client.ping();

    // 4. Parse and run features
    const result = await runFeatures(client, options, startTime);

    // 5. If launched via preLaunchTask, close the Dev Host window
    if (options.waitForDevhost) {
      console.log('Closing Extension Development Host...');
      await client.closeWindow();
    }

    return result;
  } finally {
    client.disconnect();
  }
}

/**
 * Shared: parse .feature files and run them via the controller client.
 */
export async function runFeatures(
  client: ControllerClient,
  options: RunOptions,
  startTime: number,
  artifactsDir?: string,
): Promise<TestRunResult> {
  const parser = new GherkinParser();
  const runner = new TestRunner(client, {}, artifactsDir);

  // Find all .feature files
  const featuresDir = path.resolve(options.extensionPath, options.features);
  if (!fs.existsSync(featuresDir)) {
    throw new Error(`Features directory not found: ${featuresDir}\nRun 'vscode-ext-test init' to create example tests.`);
  }

  const featureFiles = fs.readdirSync(featuresDir)
    .filter((f) => f.endsWith('.feature'))
    .map((f) => path.join(featuresDir, f));

  if (featureFiles.length === 0) {
    throw new Error(`No .feature files found in ${featuresDir}`);
  }

  console.log(`Running ${featureFiles.length} feature file(s)...\n`);

  const featureResults: FeatureResult[] = [];
  for (const filePath of featureFiles) {
    const feature = await parser.parseFile(filePath);
    const result = await runner.runFeature(feature);
    featureResults.push(result);
  }

  runner.cleanup();

  const totalPassed = featureResults.reduce((s, f) => s + f.passed, 0);
  const totalFailed = featureResults.reduce((s, f) => s + f.failed, 0);
  const totalSkipped = featureResults.reduce((s, f) => s + f.skipped, 0);

  return {
    features: featureResults,
    totalPassed,
    totalFailed,
    totalSkipped,
    durationMs: Date.now() - startTime,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
