import * as fs from 'node:fs';
import * as path from 'node:path';
import { getVsixPath } from './commands/install.js';
import { buildExtension } from './build.js';
import { execVSCodeCliSync, formatVSCodeCliMissingMessage, resolveVSCodeCli, spawnVSCodeCli } from './utils/vscode-cli.js';
import type { RunOptions } from './types.js';

/** Root directory for CLI-owned named profiles, relative to cwd. */
const PROFILES_DIR = 'tests/vscode-extension-tester/profiles';

/**
 * Resolve the on-disk root for a named profile.
 */
export function getProfileDir(name: string, cwd = process.cwd()): string {
  if (!isValidProfileName(name)) {
    throw new Error(
      `Invalid profile name: "${name}"\n` +
      'Profile names must be alphanumeric with hyphens/underscores (e.g. sql-authenticated).'
    );
  }
  return path.resolve(cwd, PROFILES_DIR, name);
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
export function profileExists(name: string, cwd = process.cwd()): boolean {
  const dir = getProfileDir(name, cwd);
  return fs.existsSync(dir) && fs.existsSync(getProfileUserDataDir(dir));
}

export function getEffectiveProfileName(options: Pick<RunOptions, 'reuseNamedProfile' | 'reuseOrCreateNamedProfile' | 'cloneNamedProfile'>): string | undefined {
  return options.reuseNamedProfile
    ?? options.reuseOrCreateNamedProfile
    ?? options.cloneNamedProfile;
}

export function validateProfileOptions(
  options: Pick<RunOptions,
    'attachDevhost' |
    'parallel' |
    'reuseNamedProfile' |
    'reuseOrCreateNamedProfile' |
    'cloneNamedProfile'
  >,
  config: { allowAttachWithProfile?: boolean; cwd?: string; log?: (message: string) => void } = {},
): void {
  const cwd = config.cwd ?? process.cwd();
  const profileFlags = getProfileFlagNames(options);

  if (profileFlags.length > 1) {
    throw new Error(
      `Only one profile strategy can be used at a time. Got: ${profileFlags.join(', ')}`
    );
  }

  if (options.attachDevhost && profileFlags.length > 0 && config.allowAttachWithProfile !== true) {
    throw new Error(
      `Profile flags are not compatible with --attach-devhost.\n` +
      'In attach mode, you use the existing Dev Host session as-is. Remove --attach-devhost to use named profiles.'
    );
  }

  if (options.parallel && (options.reuseNamedProfile || options.reuseOrCreateNamedProfile)) {
    throw new Error(
      '--parallel is not compatible with in-place profile reuse.\n' +
      'Use --clone-named-profile instead so each worker gets its own isolated copy.'
    );
  }

  if (options.reuseNamedProfile && !profileExists(options.reuseNamedProfile, cwd)) {
    throw new Error(
      `Profile "${options.reuseNamedProfile}" not found.\n` +
      `Create it first with: vscode-ext-test profile open ${options.reuseNamedProfile}`
    );
  }

  if (options.reuseOrCreateNamedProfile && !profileExists(options.reuseOrCreateNamedProfile, cwd)) {
    const dir = getProfileDir(options.reuseOrCreateNamedProfile, cwd);
    const userDataDir = getProfileUserDataDir(dir);
    const extensionsDir = getProfileExtensionsDir(dir);
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(extensionsDir, { recursive: true });
    config.log?.(`Created new profile "${options.reuseOrCreateNamedProfile}"`);
  }

  if (options.cloneNamedProfile) {
    if (!profileExists(options.cloneNamedProfile, cwd)) {
      throw new Error(
        `Profile "${options.cloneNamedProfile}" not found - cannot clone a non-existent profile.\n` +
        `Create it first with: vscode-ext-test profile open ${options.cloneNamedProfile}`
      );
    }
    throw new Error(
      'Clone-named-profile execution is not yet implemented.\n' +
      `The profile "${options.cloneNamedProfile}" exists, but cloned worker execution is planned for a future release.\n` +
      `For now, use --reuse-named-profile ${options.cloneNamedProfile} for serial execution.`
    );
  }
}

export function getProfileUserDataDirForName(name: string, cwd = process.cwd()): string {
  return getProfileUserDataDir(getProfileDir(name, cwd));
}

export function getProfileExtensionsDirForName(name: string, cwd = process.cwd()): string {
  return getProfileExtensionsDir(getProfileDir(name, cwd));
}

export function detectedUserDataDirMatchesProfile(userDataDir: string | undefined, profileName: string | undefined, cwd = process.cwd()): boolean {
  if (!profileName || !userDataDir) return false;
  return normalizePath(userDataDir) === normalizePath(getProfileUserDataDirForName(profileName, cwd));
}

export function normalizeProfilePath(value: string): string {
  return normalizePath(value);
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
  const codeCli = resolveVSCodeCli();
  if (!codeCli) {
    throw new Error(formatVSCodeCliMissingMessage());
  }

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

  // Install controller extension into this profile's user-data-dir
  const vsixPath = getVsixPath();
  console.log(`Installing controller extension into profile "${name}"...`);
  try {
    execVSCodeCliSync(codeCli, [
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${extensionsDir}`,
      '--install-extension', vsixPath,
    ], { stdio: 'inherit' });
  } catch {
    console.warn('Warning: could not install controller extension into profile.');
  }

  // If an extension path is provided, build it first so the profile gets the latest code
  if (extensionPath) {
    buildExtension(path.resolve(extensionPath));
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
  }

  if (isNew) {
    console.log(`\nCreated new profile "${name}" at:`);
  } else {
    console.log(`\nOpening existing profile "${name}" from:`);
  }
  console.log(`  ${profileDir}\n`);

  // Launch VS Code - detached so the CLI can exit while VS Code stays open
  const proc = spawnVSCodeCli(codeCli, args, {
    stdio: 'ignore',
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

function getProfileFlagNames(options: Pick<RunOptions, 'reuseNamedProfile' | 'reuseOrCreateNamedProfile' | 'cloneNamedProfile'>): string[] {
  return [
    options.reuseNamedProfile && '--reuse-named-profile',
    options.reuseOrCreateNamedProfile && '--reuse-or-create-named-profile',
    options.cloneNamedProfile && '--clone-named-profile',
  ].filter((flag): flag is string => Boolean(flag));
}

function normalizePath(value: string): string {
  return path.resolve(value).toLowerCase().replace(/\\/g, '/').replace(/\/+$/g, '');
}
