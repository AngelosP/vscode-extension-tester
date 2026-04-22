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
import { isPortInUse, findFreePort } from '../utils/port.js';

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

  const args: string[] = [
    '--new-window',
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extensionsDir}`,
    `--remote-debugging-port=${options.cdpPort}`,
    '--disable-telemetry',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    // The extension under test is loaded via extensionDevelopmentPath —
    // same as F5 / profile open.
    `--extensionDevelopmentPath=${extensionPath}`,
  ];

  // 4. Resolve controller port — avoid colliding with an already-running
  //    controller (e.g. an F5 Dev Host on the default port).
  let controllerPort = options.controllerPort;
  if (await isPortInUse(controllerPort)) {
    const freePort = await findFreePort();
    console.log(
      `Port ${controllerPort} is already in use (another VS Code instance?). ` +
      `Using port ${freePort} instead.`
    );
    controllerPort = freePort;
  }

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

  try {
    // 6. Wait for controller to be ready
    console.log('Waiting for controller extension...');
    const client = new ControllerClient(controllerPort);
    await waitForController(client, VSCODE_LAUNCH_TIMEOUT_MS);
    console.log('Connected to controller extension.\n');

    // 5b. If paused, wait for the user to press Enter before running tests.
    if (options.paused) {
      console.log('Environment ready. VS Code is running with the latest build.');
      console.log('Press Enter to run tests, or Ctrl+C to exit...\n');
      await waitForEnter();
    }

    // 6. Run tests
    const result = await runFeatures(client, options, startTime, artifactsDir, userDataDir);
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

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.setEncoding('utf-8');
    process.stdin.once('data', () => resolve());
    process.stdin.resume();
  });
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
