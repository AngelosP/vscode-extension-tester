import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as cp from 'node:child_process';
import type { RunOptions, TestRunResult } from '../types.js';
import { VSCODE_LAUNCH_TIMEOUT_MS } from '../types.js';
import { ControllerClient } from '../runner/controller-client.js';
import { runFeatures } from './dev-mode.js';
import { getVsixPath } from '../commands/install.js';
import { getProfileDir, getProfileExtensionsDir, getProfileUserDataDir, getProfilePreferredVSCodeExecutable, markProfileAsUserDataDir } from '../profile.js';
import { isPortInUse, findFreePort } from '../utils/port.js';
import { resolveVSCodeCli, resolveVSCodeExecutablePath } from '../utils/vscode-cli.js';
import { removeControllerLaunchRequest, writeControllerLaunchRequest } from '../controller-launch.js';

const CONTROLLER_RUNTIME_EXTENSION_NAME = 'vscode-extension-tester-controller-runtime';

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
export async function launchMode(options: RunOptions, artifactsDir?: string): Promise<TestRunResult> {
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
    return await runFeatures(session.client, runOptions, startTime, artifactsDir, session.userDataDir, session.cdpPort, session.targetPid);
  } finally {
    await session.close();
  }
}

export async function createLaunchDevHostSession(options: RunOptions): Promise<LaunchDevHostSession> {
  const extensionPath = path.resolve(options.extensionPath);
  const profileName = options.reuseNamedProfile ?? options.reuseOrCreateNamedProfile ?? options.cloneNamedProfile;

  // 1. Resolve VS Code executable. Named profiles are stateful, so by default
  // use the installed VS Code executable that `profile open` uses. This avoids
  // preparing auth state in one VS Code build and running tests in another.
  const installedVSCodePath = resolveNamedProfileVSCodeExecutable(profileName, extensionPath, options.vscodeVersion);
  let vscPath: string;
  if (installedVSCodePath) {
    vscPath = installedVSCodePath;
    console.log(`Using installed VS Code for named profile: ${vscPath}`);
  } else {
    console.log(`Downloading VS Code (${options.vscodeVersion})...`);
    const { download } = await import('@vscode/test-electron');
    vscPath = await download({
      version: options.vscodeVersion === 'stable' ? undefined : options.vscodeVersion,
    });
    console.log('VS Code downloaded.');
  }

  // 2. Resolve profile state. Named profiles use profile-owned user-data and
  // extensions dirs so test windows start from a stable prepared state without
  // sharing the main VS Code instance state.
  const isEphemeral = !profileName;
  let userDataDir: string;
  let extensionsDir: string | undefined;
  let profileDir: string | undefined;

  if (profileName) {
    profileDir = getProfileDir(profileName, extensionPath);
    const profileManifest = markProfileAsUserDataDir(profileName, extensionPath);
    userDataDir = getProfileUserDataDir(profileDir);
    extensionsDir = getProfileExtensionsDir(profileDir);
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(extensionsDir, { recursive: true });
    console.log(`Using named profile "${profileName}" (${profileManifest.storageKind})`);
  } else {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-ext-test-'));
  }

  // 3. Build launch args
  const controllerVsix = getVsixPath();
  const controllerDevRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-ext-test-controller-'));
  const controllerDevDir = path.join(controllerDevRoot, 'extension');
  extractVsix(controllerVsix, controllerDevDir);
  patchControllerRuntimeManifest(controllerDevDir);
  if (profileDir) {
    refreshLegacyControllerDevDir(controllerVsix, profileDir);
  }
  let workspaceFilePath: string | undefined;

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

  const workspacePath = process.env.VSCODE_EXT_TEST_WORKSPACE
    ? path.resolve(process.env.VSCODE_EXT_TEST_WORKSPACE)
    : profileName
      ? extensionPath
      : undefined;
  const requestWorkspacePath = process.env.VSCODE_EXT_TEST_WORKSPACE
    ? path.resolve(process.env.VSCODE_EXT_TEST_WORKSPACE)
    : profileName
      ? extensionPath
      : undefined;

  const launchRequestPath = writeControllerLaunchRequest(controllerPort, profileName, requestWorkspacePath);

  // For ephemeral runs, use a temp extensions directory so VS Code doesn't
  // reuse a cached (stale) version of the controller extension.
  if (!extensionsDir) {
    extensionsDir = path.join(userDataDir, 'extensions');
    fs.mkdirSync(extensionsDir, { recursive: true });
  }

  clearWindowRestoreState(userDataDir);

  const args: string[] = ['--new-window'];
  args.push(`--user-data-dir=${userDataDir}`, `--extensions-dir=${extensionsDir}`);

  args.push(
    `--remote-debugging-port=${cdpPort}`,
    '--disable-telemetry',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-restore-windows',
    '--disable-workspace-trust',
    // The controller is loaded as a fresh development extension so launch mode
    // never depends on an installed or profile-cached controller copy.
    `--extensionDevelopmentPath=${controllerDevDir}`,
    // The extension under test is loaded via extensionDevelopmentPath —
    // same as F5 / profile open.
    `--extensionDevelopmentPath=${extensionPath}`,
  );

  if (workspacePath) args.push(workspacePath);

  // 5. Launch VS Code (with xvfb on Linux if needed)
  console.log('Launching VS Code...');
  let vscProcess: cp.ChildProcess;

  if (process.platform === 'linux' && (options.xvfb || isHeadlessCI())) {
    vscProcess = cp.spawn('xvfb-run', ['-a', vscPath, ...args], {
      stdio: 'pipe',
      env: { ...process.env, VSCODE_EXT_TESTER_PORT: String(controllerPort) },
    });
  } else {
    vscProcess = cp.spawn(vscPath, args, {
      stdio: 'pipe',
      env: { ...process.env, VSCODE_EXT_TESTER_PORT: String(controllerPort) },
    });
  }

  // 6. Wait for controller to be ready
  console.log('Waiting for controller extension...');
  const client = new ControllerClient(controllerPort, options.timeout);
  try {
    await waitForController(client, VSCODE_LAUNCH_TIMEOUT_MS);
    console.log('Connected to controller extension.\n');
  } catch (err) {
    removeControllerLaunchRequest(launchRequestPath);
    removeControllerRuntime(controllerDevRoot);
    removeLaunchWorkspace(workspaceFilePath);
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
      await client.closeWindow();
      await waitForControllerToStop(controllerPort, 5_000);
      client.disconnect();
      removeControllerLaunchRequest(launchRequestPath);
      removeControllerRuntime(controllerDevRoot);
      removeLaunchWorkspace(workspaceFilePath);
      await closeLaunchedProcess(vscProcess, isEphemeral, userDataDir);
    },
  };
}

function resolveNamedProfileVSCodeExecutable(profileName: string | undefined, cwd: string, vscodeVersion: string): string | undefined {
  if (!profileName || vscodeVersion !== 'stable') return undefined;

  const profileExecutable = getProfilePreferredVSCodeExecutable(profileName, cwd);
  if (profileExecutable) return profileExecutable;

  const codeCli = resolveVSCodeCli();
  return codeCli ? resolveVSCodeExecutablePath(codeCli) ?? undefined : undefined;
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

async function waitForControllerToStop(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortInUse(port))) return;
    await delay(100);
  }
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

function patchControllerRuntimeManifest(controllerDevDir: string): void {
  const packageJsonPath = path.join(controllerDevDir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as Record<string, unknown>;
  manifest.name = CONTROLLER_RUNTIME_EXTENSION_NAME;
  manifest.displayName = 'Extension Tester Controller Runtime';
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
}

function createLaunchWorkspaceFile(extensionPath: string): string {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-ext-test-workspace-'));
  const workspaceFile = path.join(workspaceRoot, 'workspace.code-workspace');
  fs.writeFileSync(
    workspaceFile,
    `${JSON.stringify({ folders: [{ path: extensionPath }] }, null, 2)}\n`,
    'utf-8',
  );
  return workspaceFile;
}

function refreshLegacyControllerDevDir(controllerVsix: string, profileDir: string): void {
  const profileRoot = path.dirname(profileDir);
  const dirs = new Set<string>([path.join(getProfileUserDataDir(profileDir), '_controller-dev')]);

  try {
    for (const entry of fs.readdirSync(profileRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(profileRoot, entry.name, 'user-data', '_controller-dev');
      if (fs.existsSync(candidate)) dirs.add(candidate);
    }
  } catch {
    // best-effort compatibility refresh
  }

  for (const legacyControllerDevDir of dirs) {
    fs.rmSync(legacyControllerDevDir, { recursive: true, force: true });
    fs.mkdirSync(legacyControllerDevDir, { recursive: true });
    extractVsix(controllerVsix, legacyControllerDevDir);
  }
}

function removeLaunchWorkspace(workspaceFilePath: string | undefined): void {
  if (!workspaceFilePath) return;
  try {
    fs.rmSync(path.dirname(workspaceFilePath), { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

function removeControllerRuntime(controllerDevRoot: string): void {
  try {
    fs.rmSync(controllerDevRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
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
