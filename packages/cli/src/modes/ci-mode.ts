import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as cp from 'node:child_process';
import type { RunOptions, TestRunResult } from '../types.js';
import { CONTROLLER_EXTENSION_ID, VSCODE_LAUNCH_TIMEOUT_MS } from '../types.js';
import { ControllerClient } from '../runner/controller-client.js';
import type { TestRunnerOptions } from '../runner/test-runner.js';
import { runFeatures } from './dev-mode.js';
import { getVsixPath } from '../commands/install.js';
import { getProfileDir, getProfileUserDataDir, getProfileExtensionsDir, getProfileSharedDataDir, ensureProfileAuthLocalState } from '../profile.js';
import { isPortInUse, findFreePort } from '../utils/port.js';

export interface LaunchDevHostSession {
  mode: 'launch';
  client: ControllerClient;
  controllerPort: number;
  cdpPort: number;
  userDataDir: string;
  targetPid?: number;
  close: () => Promise<void>;
}

/**
 * Launch mode (default): download/launch an isolated VS Code instance, install
 * extensions, run tests, shut down. No Dev Host or F5 session needed.
 *
 * When a named profile is provided via RunOptions, uses that profile's
 * user-data and extensions directories instead of creating ephemeral ones.
 */
export async function launchMode(options: RunOptions, artifactsDir?: string, runnerOptions?: TestRunnerOptions): Promise<TestRunResult> {
  const startTime = Date.now();

  const session = await createLaunchDevHostSession(options);
  try {
    // If paused, wait for the user to press Enter before running tests.
    if (options.paused) {
      console.log('Environment ready. VS Code is running with the latest build.');
      console.log('Press Enter to run tests, or Ctrl+C to exit...\n');
      await waitForEnter();
    }

    const runOptions: RunOptions = {
      ...options,
      controllerPort: session.controllerPort,
      cdpPort: session.cdpPort,
    };
    return await runFeatures(session.client, runOptions, startTime, artifactsDir, session.userDataDir, session.cdpPort, session.targetPid, runnerOptions);
  } finally {
    await session.close();
  }
}

export async function createLaunchDevHostSession(options: RunOptions): Promise<LaunchDevHostSession> {
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
  let sharedDataDir: string;

  if (profileName) {
    const profileDir = getProfileDir(profileName, path.resolve(options.extensionPath));
    userDataDir = getProfileUserDataDir(profileDir);
    extensionsDir = getProfileExtensionsDir(profileDir);
    sharedDataDir = getProfileSharedDataDir(profileDir);
    fs.mkdirSync(sharedDataDir, { recursive: true });
    ensureProfileAuthLocalState(profileDir, userDataDir);
    clearWindowRestoreState(userDataDir);
    console.log(`Using named profile "${profileName}"`);
  } else {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-ext-test-'));
    sharedDataDir = path.join(userDataDir, 'shared-data');
    fs.mkdirSync(sharedDataDir, { recursive: true });
  }

  // 3. Build launch args
  const controllerVsix = getVsixPath();
  const extensionPath = path.resolve(options.extensionPath);

  // For ephemeral runs, use a temp extensions directory so VS Code doesn't
  // reuse a cached (stale) version of the controller extension.
  if (!extensionsDir) {
    extensionsDir = path.join(userDataDir, 'extensions');
    fs.mkdirSync(extensionsDir, { recursive: true });
  }

  // Extract the controller VSIX and symlink it into the extensions directory
  // so VS Code discovers it as a normally installed extension.  This keeps the
  // controller available regardless of how many extensionDevelopmentPath entries
  // there are.
  const controllerDevDir = path.join(userDataDir, '_controller-dev');
  fs.mkdirSync(controllerDevDir, { recursive: true });
  extractVsix(controllerVsix, controllerDevDir);
  linkExtensionIntoDir(controllerDevDir, extensionsDir, '_controller');
  console.log('Controller extension installed into extensions dir.');

  // 4. Resolve ports — avoid colliding with an already-running VS Code
  //    (e.g. an F5 Dev Host on the default ports).
  let controllerPort = options.controllerPort;
  if (await isPortInUse(controllerPort)) {
    const freePort = await findFreePort();
    console.log(
      `Controller port ${controllerPort} is already in use (another VS Code instance?). ` +
      `Using port ${freePort} instead.`
    );
    controllerPort = freePort;
  }

  let cdpPort = options.cdpPort;
  if (await isPortInUse(cdpPort)) {
    const freePort = await findFreePort();
    console.log(
      `CDP port ${cdpPort} is already in use (another VS Code instance?). ` +
      `Using port ${freePort} instead.`
    );
    cdpPort = freePort;
  }

  const args: string[] = [
    '--new-window',
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extensionsDir}`,
    `--shared-data-dir=${sharedDataDir}`,
    `--remote-debugging-port=${cdpPort}`,
    '--disable-telemetry',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-restore-windows',
    '--disable-workspace-trust',
    // The extension under test is loaded via extensionDevelopmentPath —
    // same as F5 / profile open.
    `--extensionDevelopmentPath=${extensionPath}`,
  ];

  const userArgs = normalizeUserVsCodeArgs(options.vscodeArgs ?? [], cdpPort);
  if (userArgs.some((arg) => arg === '--disable-extensions')) {
    args.push(`--extensionDevelopmentPath=${controllerDevDir}`);
  }
  args.push(...userArgs);

  if (process.env.VSCODE_EXT_TEST_WORKSPACE) {
    args.push(path.resolve(process.env.VSCODE_EXT_TEST_WORKSPACE));
  }

  // 5. Launch VS Code (with xvfb on Linux if needed)
  console.log('Launching VS Code...');
  let vscProcess: cp.ChildProcess;

  if (process.platform === 'linux' && (options.xvfb || isHeadlessCI())) {
    vscProcess = cp.spawn('xvfb-run', ['-a', vscPath, ...args], {
      stdio: 'pipe',
      env: { ...process.env, ...(options.env ?? {}), VSCODE_EXT_TESTER_PORT: String(controllerPort) },
    });
  } else {
    vscProcess = cp.spawn(vscPath, args, {
      stdio: 'pipe',
      env: { ...process.env, ...(options.env ?? {}), VSCODE_EXT_TESTER_PORT: String(controllerPort) },
    });
  }

  // 6. Wait for controller to be ready
  console.log('Waiting for controller extension...');
  const client = new ControllerClient(controllerPort, options.timeout);
  try {
    await waitForController(client, VSCODE_LAUNCH_TIMEOUT_MS);
    console.log('Connected to controller extension.\n');
  } catch (err) {
    await closeLaunchedProcess(vscProcess, isEphemeral, userDataDir);
    throw err;
  }

  let closed = false;
  return {
    mode: 'launch',
    client,
    controllerPort,
    cdpPort,
    userDataDir,
    targetPid: vscProcess.pid,
    close: async () => {
      if (closed) return;
      closed = true;
      client.disconnect();
      await closeLaunchedProcess(vscProcess, isEphemeral, userDataDir);
    },
  };
}

function normalizeUserVsCodeArgs(rawArgs: string[], cdpPort: number): string[] {
  const result: string[] = [];
  const blockedPrefixes = [
    '--user-data-dir',
    '--extensions-dir',
    '--shared-data-dir',
    '--extensionDevelopmentPath',
    '--extension-development-path',
  ];

  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index];
    const lower = arg.toLowerCase();
    const [name] = lower.split('=', 1);
    if (blockedPrefixes.some((prefix) => name === prefix.toLowerCase())) {
      throw new Error(`--vscode-arg ${arg} is managed by vscode-ext-test and cannot be overridden.`);
    }
    if (name === '--remote-debugging-port') {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : rawArgs[index + 1];
      if (value === '0') {
        throw new Error('--vscode-arg --remote-debugging-port=0 is not supported because the runner must know the CDP port. Use --cdp-port <n> instead.');
      }
      const requestedPort = value ? parseInt(value, 10) : Number.NaN;
      if (!Number.isFinite(requestedPort) || requestedPort !== cdpPort) {
        throw new Error(`--remote-debugging-port is managed by vscode-ext-test. Use --cdp-port ${value ?? '<n>'} instead.`);
      }
      if (!arg.includes('=')) index++;
      continue;
    }
    if (name === '--disable-extension') {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : rawArgs[index + 1];
      if (value?.toLowerCase() === CONTROLLER_EXTENSION_ID.toLowerCase()) {
        throw new Error(`--vscode-arg cannot disable the controller extension (${CONTROLLER_EXTENSION_ID}).`);
      }
      result.push(arg);
      if (!arg.includes('=') && value !== undefined) {
        result.push(value);
        index++;
      }
      continue;
    }
    result.push(arg);
  }

  return result;
}

async function closeLaunchedProcess(vscProcess: cp.ChildProcess, isEphemeral: boolean, userDataDir: string): Promise<void> {
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

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.setEncoding('utf-8');
    process.stdin.once('data', () => resolve());
    process.stdin.resume();
  });
}

function clearWindowRestoreState(userDataDir: string): void {
  const storagePath = path.join(userDataDir, 'User', 'globalStorage', 'storage.json');
  try {
    if (!fs.existsSync(storagePath)) return;
    const storage = JSON.parse(fs.readFileSync(storagePath, 'utf-8')) as Record<string, unknown>;
    storage.windowsState = { openedWindows: [] };
    storage.backupWorkspaces = { workspaces: [], folders: [], emptyWindows: [] };
    fs.writeFileSync(storagePath, JSON.stringify(storage, null, 4));
    fs.rmSync(path.join(userDataDir, 'Workspaces'), { recursive: true, force: true });
    console.log('Cleared named profile window restore state.');
  } catch (error) {
    console.warn(`Failed to clear named profile window restore state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Extract a VSIX (which is a zip) so its `extension/` content ends up
 * directly in `destDir`.  The VSIX layout is:
 *   [Content_Types].xml
 *   extension.vsixmanifest
 *   extension/            ← the actual extension (package.json, dist/, …)
 *
 * We copy only the `extension/` subtree into `destDir` so it's a valid
 * extensionDevelopmentPath.
 */
function extractVsix(vsixPath: string, destDir: string): void {
  // VSIX is a zip — extract using PowerShell (Windows) or unzip (Linux/macOS)
  const tmpZip = path.join(path.dirname(destDir), '_controller.zip');
  fs.copyFileSync(vsixPath, tmpZip);

  const extractDir = path.join(path.dirname(destDir), '_controller-raw');
  fs.mkdirSync(extractDir, { recursive: true });

  if (process.platform === 'win32') {
    cp.execSync(
      `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${tmpZip}' -DestinationPath '${extractDir}' -Force"`,
      { stdio: 'pipe', timeout: 30_000 },
    );
  } else {
    cp.execSync(`unzip -o -q "${tmpZip}" -d "${extractDir}"`, {
      stdio: 'pipe', timeout: 30_000,
    });
  }

  // Move extension/ contents into destDir
  const extSubDir = path.join(extractDir, 'extension');
  if (fs.existsSync(extSubDir)) {
    copyDirSync(extSubDir, destDir);
  }

  // Cleanup
  try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { /* */ }
  try { fs.rmSync(tmpZip); } catch { /* */ }
}

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Ensure an extension is reachable from `extensionsDir` by creating a
 * directory junction (Windows) or symlink (posix) that points back to
 * the source tree.  VS Code scans `extensionsDir` for subdirectories
 * containing a `package.json` and loads them as installed extensions, so the
 * symlink makes the latest compiled code available without packaging a VSIX.
 */
function linkExtensionIntoDir(extensionPath: string, extensionsDir: string, linkName = '_ext-under-test'): void {
  const linkPath = path.join(extensionsDir, linkName);

  // Remove stale link/dir from a previous run
  try { fs.rmSync(linkPath, { recursive: true, force: true }); } catch { /* */ }

  fs.symlinkSync(
    extensionPath,
    linkPath,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  console.log(`Extension linked: ${linkPath} → ${extensionPath}`);
}
