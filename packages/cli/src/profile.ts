import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cp from 'node:child_process';
import { getVsixPath } from './commands/install.js';

/** Root directory for CLI-owned named profiles, relative to cwd. */
const PROFILES_DIR = 'tests/vscode-extension-tester/profiles';

/**
 * Resolve the on-disk root for a named profile.
 */
export function getProfileDir(name: string): string {
  if (!isValidProfileName(name)) {
    throw new Error(
      `Invalid profile name: "${name}"\n` +
      'Profile names must be alphanumeric with hyphens/underscores (e.g. sql-authenticated).'
    );
  }
  return path.resolve(process.cwd(), PROFILES_DIR, name);
}

/**
 * Get the user-data-dir inside a named profile root.
 */
export function getProfileUserDataDir(profileDir: string): string {
  return path.join(profileDir, 'user-data');
}

/**
 * Get the extensions-dir inside a named profile root.
 * Isolates extensions so a new profile starts clean instead of inheriting
 * the user's global extensions.
 */
export function getProfileExtensionsDir(profileDir: string): string {
  return path.join(profileDir, 'extensions');
}

/**
 * Check whether a named profile exists on disk.
 */
export function profileExists(name: string): boolean {
  const dir = getProfileDir(name);
  return fs.existsSync(dir) && fs.existsSync(getProfileUserDataDir(dir));
}

/**
 * Open a named profile in VS Code so the user can authenticate or prepare
 * prerequisites. Creates the profile if it doesn't exist.
 *
 * This launches VS Code with --user-data-dir pointed at the profile's
 * user-data directory and the controller extension installed, then returns
 * immediately so the user can interact with the VS Code window.
 */
export function openProfile(name: string, extensionPath?: string): void {
  const profileDir = getProfileDir(name);
  const userDataDir = getProfileUserDataDir(profileDir);

  const extensionsDir = getProfileExtensionsDir(profileDir);

  const isNew = !fs.existsSync(userDataDir);
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(extensionsDir, { recursive: true });

  // Write a small manifest so we can identify this profile later
  const manifestPath = path.join(profileDir, 'profile.json');
  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(manifestPath, JSON.stringify({
      name,
      created: new Date().toISOString(),
    }, null, 2), 'utf-8');
  }

  const codeCmd = process.platform === 'win32' ? 'code.cmd' : 'code';

  // Install controller extension into this profile's user-data-dir
  const vsixPath = getVsixPath();
  console.log(`Installing controller extension into profile "${name}"...`);
  try {
    cp.execFileSync(codeCmd, [
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${extensionsDir}`,
      '--install-extension', vsixPath,
    ], { stdio: 'inherit', shell: process.platform === 'win32' });
  } catch {
    console.warn('Warning: could not install controller extension into profile.');
  }

  // Build launch args
  const args: string[] = [
    '--new-window',
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extensionsDir}`,
    '--disable-workspace-trust',
  ];

  // If an extension path is provided, load the extension under test
  if (extensionPath) {
    const resolved = path.resolve(extensionPath);
    args.push(`--extensionDevelopmentPath=${resolved}`);
    args.push(resolved);
  }

  if (isNew) {
    console.log(`\nCreated new profile "${name}" at:`);
  } else {
    console.log(`\nOpening existing profile "${name}" from:`);
  }
  console.log(`  ${profileDir}\n`);

  // Launch VS Code - detached so the CLI can exit while VS Code stays open
  const proc = cp.spawn(codeCmd, args, {
    stdio: 'ignore',
    shell: process.platform === 'win32',
    detached: true,
  });
  proc.unref();

  console.log('VS Code is opening. Authenticate, install extensions, or do whatever');
  console.log('preparation you need, then close the window when you\'re done.');
  console.log(`\nTo run tests with this profile later:`);
  console.log(`  vscode-ext-test run --test-id <slug> --reuse-named-profile ${name}\n`);
}

/**
 * Delete a named profile and all its data.
 */
export function deleteProfile(name: string): void {
  const profileDir = getProfileDir(name);

  if (!fs.existsSync(profileDir)) {
    throw new Error(`Profile "${name}" not found at ${profileDir}`);
  }

  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('EBUSY') || msg.includes('resource busy')) {
      throw new Error(
        `Cannot delete profile "${name}" - it appears to be in use.\n` +
        'Close any VS Code windows using this profile first, then try again.'
      );
    }
    throw err;
  }
  console.log(`Deleted profile "${name}" from ${profileDir}`);
}

/**
 * List all named profiles.
 */
export function listProfiles(): string[] {
  const dir = path.resolve(process.cwd(), PROFILES_DIR);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir).filter((entry) => {
    const full = path.join(dir, entry);
    return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'user-data'));
  });
}

function isValidProfileName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name);
}
