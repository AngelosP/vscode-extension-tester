import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunOptions, TestRunResult, FeatureResult } from '../types.js';
import { detectDevHost } from '../utils/dev-host-detector.js';
import { ControllerClient } from '../runner/controller-client.js';
import { GherkinParser } from '../runner/gherkin-parser.js';
import { TestRunner } from '../runner/test-runner.js';

/**
 * Attach mode: connect to an already-running Extension Development Host and
 * run tests. The user must have launched the Dev Host themselves (e.g. via F5).
 */
export async function attachMode(options: RunOptions, artifactsDir?: string): Promise<TestRunResult> {
  const startTime = Date.now();

  // 1. Fast-fail: verify a Dev Host process exists before polling the WebSocket
  const devHost = await detectDevHost();
  if (!devHost) {
    throw new Error(
      'No Extension Development Host found.\n' +
      'Make sure you have started a debug session (F5) first.\n' +
      'Or remove --attach-devhost to launch an isolated VS Code instance automatically.'
    );
  }
  console.log(`Found Extension Development Host (PID: ${devHost.pid})`);

  // 2. Connect to the controller extension WebSocket
  const client = new ControllerClient(options.controllerPort);
  console.log(`Connecting to controller on port ${options.controllerPort}...`);
  let connected = false;

  for (let attempt = 0; attempt < 60; attempt++) {
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
      `Could not connect to controller extension on port ${options.controllerPort} within 60s.\n` +
      'Make sure the controller extension is installed: vscode-ext-test install'
    );
  }

  console.log('Connected to controller extension.\n');

  try {
    // 3. Verify connection
    await client.ping();

    // 4. Parse and run features
    return await runFeatures(client, options, startTime, artifactsDir);
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
