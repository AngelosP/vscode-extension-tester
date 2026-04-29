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

    // 3b. If we built the extension, reload the Dev Host window so it loads
    //     the latest compiled code — same effect as pressing the restart
    //     button in the debug toolbar.
    if (options.build) {
      console.log('Reloading Dev Host to pick up latest build...');
      try {
        await client.executeCommand('workbench.action.reloadWindow');
      } catch {
        // Window may close before the response arrives — that's expected.
      }
      client.disconnect();

      // Give VS Code a moment to begin reloading before we start polling.
      await delay(3000);

      // Reconnect — the controller extension will re-activate after reload.
      let reconnected = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          await client.connect();
          await client.ping();
          reconnected = true;
          break;
        } catch {
          await delay(1000);
        }
      }
      if (!reconnected) {
        throw new Error(
          'Dev Host did not come back after reload within 60s.\n' +
          'Try reloading manually (Ctrl+Shift+P → "Reload Window") and re-running tests.'
        );
      }
      console.log('Dev Host reloaded — running with latest code.\n');
    }

    // 3c. If paused, wait for the user to press Enter before running tests.
    if (options.paused) {
      console.log('Environment ready. VS Code is running with the latest build.');
      console.log('Press Enter to run tests, or Ctrl+C to exit...\n');
      await waitForEnter();
    }

    // 4. Parse and run features
    return await runFeatures(client, options, startTime, artifactsDir, undefined, options.cdpPort, devHost.pid);
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
  userDataDir?: string,
  cdpPort?: number,
  targetPid?: number,
): Promise<TestRunResult> {
  const parser = new GherkinParser();
  const runner = new TestRunner(client, {}, artifactsDir, userDataDir, cdpPort, targetPid);

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

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.setEncoding('utf-8');
    process.stdin.once('data', () => resolve());
    process.stdin.resume();
  });
}
