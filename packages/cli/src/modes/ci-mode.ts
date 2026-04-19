import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as cp from 'node:child_process';
import type { RunOptions, TestRunResult } from '../types.js';
import { VSCODE_LAUNCH_TIMEOUT_MS } from '../types.js';
import { ControllerClient } from '../runner/controller-client.js';
import { runFeatures } from './dev-mode.js';
import { getVsixPath } from '../commands/install.js';
import { getProfileDir, getProfileUserDataDir, getProfileExtensionsDir } from '../profile.js';

/**
 * Launch mode (default): download/launch an isolated VS Code instance, install
 * extensions, run tests, shut down. No Dev Host or F5 session needed.
 *
 * When a named profile is provided via RunOptions, uses that profile's
 * user-data and extensions directories instead of creating ephemeral ones.
 */
export async function launchMode(options: RunOptions, artifactsDir?: string): Promise<TestRunResult> {
  const startTime = Date.now();

  // 1. Download VS Code
  console.log(`Downloading VS Code (${options.vscodeVersion})...`);
  const { download } = await import('@vscode/test-electron');
  const vscPath = await download({
    version: options.vscodeVersion === 'stable' ? undefined : options.vscodeVersion,
  });
  console.log('VS Code downloaded.');

  // 2. Resolve user-data and extensions directories
  const profileName = options.reuseNamedProfile ?? options.reuseOrCreateNamedProfile ?? options.cloneNamedProfile;
  const isEphemeral = !profileName;
  let userDataDir: string;
  let extensionsDir: string | undefined;

  if (profileName) {
    const profileDir = getProfileDir(profileName);
    userDataDir = getProfileUserDataDir(profileDir);
    extensionsDir = getProfileExtensionsDir(profileDir);
    console.log(`Using named profile "${profileName}"`);
  } else {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-ext-test-'));
  }

  // 3. Build launch args
  const controllerVsix = getVsixPath();
  const extensionPath = path.resolve(options.extensionPath);
  const args: string[] = [
    '--new-window',
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${options.cdpPort}`,
    '--disable-telemetry',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    `--install-extension`, controllerVsix,
    `--extensionDevelopmentPath=${extensionPath}`,
  ];
  if (extensionsDir) {
    args.push(`--extensions-dir=${extensionsDir}`);
  }

  // 4. Launch VS Code (with xvfb on Linux if needed)
  console.log('Launching VS Code...');
  let vscProcess: cp.ChildProcess;

  if (process.platform === 'linux' && (options.xvfb || isHeadlessCI())) {
    vscProcess = cp.spawn('xvfb-run', ['-a', vscPath, ...args], {
      stdio: 'pipe',
      env: { ...process.env, VSCODE_EXT_TESTER_PORT: String(options.controllerPort) },
    });
  } else {
    vscProcess = cp.spawn(vscPath, args, {
      stdio: 'pipe',
      env: { ...process.env, VSCODE_EXT_TESTER_PORT: String(options.controllerPort) },
    });
  }

  try {
    // 5. Wait for controller to be ready
    console.log('Waiting for controller extension...');
    const client = new ControllerClient(options.controllerPort);
    await waitForController(client, VSCODE_LAUNCH_TIMEOUT_MS);
    console.log('Connected to controller extension.\n');

    // 6. Run tests
    const result = await runFeatures(client, options, startTime, artifactsDir);
    client.disconnect();
    return result;
  } finally {
    // 7. Clean up - shut down VS Code, only delete ephemeral temp dirs
    vscProcess.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { vscProcess.kill('SIGKILL'); resolve(); }, 5000);
      vscProcess.on('exit', () => { clearTimeout(timer); resolve(); });
    });

    if (isEphemeral) {
      try {
        if (userDataDir.includes('vscode-ext-test-')) {
          fs.rmSync(userDataDir, { recursive: true, force: true });
        }
      } catch { /* best-effort cleanup */ }
    }
  }
}

async function waitForController(client: ControllerClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await client.connect();
      await client.ping();
      return;
    } catch {
      client.disconnect();
      await delay(1000);
    }
  }
  throw new Error(`Controller extension did not start within ${Math.round(timeoutMs / 1000)}s`);
}

function isHeadlessCI(): boolean {
  return process.env['CI'] === 'true' || process.env['GITHUB_ACTIONS'] === 'true';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
