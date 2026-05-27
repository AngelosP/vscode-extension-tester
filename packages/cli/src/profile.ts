import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as cp from 'node:child_process';
import { buildExtension } from './build.js';
import { formatVSCodeCliMissingMessage, getVSCodeCliMetadata, resolveVSCodeCli, type VSCodeCliMetadata } from './utils/vscode-cli.js';
import { CONTROLLER_EXTENSION_ID, type RunOptions } from './types.js';

/** Root directory for CLI-owned named profiles, relative to cwd. */
const PROFILES_DIR = 'tests/vscode-extension-tester/profiles';

export interface ProfileManifest {
  name: string;
  created: string;
  lastOpened?: string;
  vscodeCli?: VSCodeCliMetadata;
  authStorageResetAt?: string;
  nativeProfileName?: string;
  storageKind?: 'native-vscode-profile' | 'legacy-user-data-dir';
  schemaVersion?: number;
}

export interface ProfileDoctorReport {
  name: string;
  profileDir: string;
  exists: boolean;
  userDataDir: string;
  userDataDirExists: boolean;
  extensionsDir: string;
  extensionsDirExists: boolean;
  controllerInstalled: boolean;
  manifest?: ProfileManifest;
  currentVSCode?: VSCodeCliMetadata;
  nativeProfileName: string;
  storageKind: 'native-vscode-profile' | 'legacy-user-data-dir';
  auth: ProfileAuthStateSummary;
  repairs: string[];
  warnings: string[];
  errors: string[];
}

export interface ProfileAuthStateSummary {
  stateDbPath: string;
  stateDbExists: boolean;
  githubAuthSecretMarkers: number;
  githubAuthMentions: number;
  loginAccountMentions: number;
  githubAuthLogPath?: string;
  githubAuthLogLastSessionCount?: number;
  githubAuthLogLoginSuccess: boolean;
  copilotChatLogPath?: string;
  copilotTokenSeen: boolean;
  copilotNotSignedInSeen: boolean;
  copilotPermissiveAuthErrorSeen: boolean;
  safeStorageDecryptErrors: number;
  safeStorageDecryptLogPath?: string;
  safeStorageDecryptErrorMtimeMs?: number;
}

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

export function getNativeVSCodeProfileName(name: string): string {
  if (!isValidProfileName(name)) {
    throw new Error(
      `Invalid profile name: "${name}"\n` +
      'Profile names must be alphanumeric with hyphens/underscores (e.g. sql-authenticated).'
    );
  }
  return `vscode-ext-test-${name}`;
}

export function getVSCodeUserDataDir(vscodeCli?: Pick<VSCodeCliMetadata, 'variant'>): string | undefined {
  const appName = vscodeCli?.variant === 'insiders' ? 'Code - Insiders' : 'Code';
  if (process.platform === 'win32') {
    return process.env.APPDATA ? path.join(process.env.APPDATA, appName) : undefined;
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appName);
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), appName);
}

export function getProfileManifestPath(profileDir: string): string {
  return path.join(profileDir, 'profile.json');
}

export function readProfileManifest(profileDir: string): ProfileManifest | undefined {
  const manifestPath = getProfileManifestPath(profileDir);
  try {
    if (!fs.existsSync(manifestPath)) return undefined;
    const value = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Partial<ProfileManifest>;
    if (typeof value.name !== 'string' || typeof value.created !== 'string') return undefined;
    return value as ProfileManifest;
  } catch {
    return undefined;
  }
}

export function writeProfileManifest(profileDir: string, manifest: ProfileManifest): void {
  fs.writeFileSync(getProfileManifestPath(profileDir), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
}

/**
 * Check whether a named profile exists on disk.
 */
export function profileExists(name: string, cwd = process.cwd()): boolean {
  const dir = getProfileDir(name, cwd);
  return fs.existsSync(dir) && (fs.existsSync(getProfileManifestPath(dir)) || fs.existsSync(getProfileUserDataDir(dir)));
}

export function markProfileAsNative(name: string, cwd = process.cwd(), vscodeCli?: VSCodeCliMetadata, lastOpened?: string): ProfileManifest {
  const profileDir = getProfileDir(name, cwd);
  const userDataDir = getProfileUserDataDir(profileDir);
  const extensionsDir = getProfileExtensionsDir(profileDir);
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(extensionsDir, { recursive: true });

  const manifest = readProfileManifest(profileDir);
  const next: ProfileManifest = {
    name,
    created: manifest?.created ?? new Date().toISOString(),
    lastOpened: lastOpened ?? manifest?.lastOpened,
    authStorageResetAt: manifest?.authStorageResetAt,
    nativeProfileName: getNativeVSCodeProfileName(name),
    storageKind: 'native-vscode-profile',
    vscodeCli: vscodeCli ?? manifest?.vscodeCli,
    schemaVersion: 3,
  };
  writeProfileManifest(profileDir, next);
  return next;
}

export function markProfileAsUserDataDir(name: string, cwd = process.cwd(), vscodeCli?: VSCodeCliMetadata, lastOpened?: string): ProfileManifest {
  const profileDir = getProfileDir(name, cwd);
  const userDataDir = getProfileUserDataDir(profileDir);
  const extensionsDir = getProfileExtensionsDir(profileDir);
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(extensionsDir, { recursive: true });

  const manifest = readProfileManifest(profileDir);
  const next: ProfileManifest = {
    name,
    created: manifest?.created ?? new Date().toISOString(),
    lastOpened: lastOpened ?? manifest?.lastOpened,
    authStorageResetAt: manifest?.authStorageResetAt,
    storageKind: 'legacy-user-data-dir',
    vscodeCli: vscodeCli ?? (manifest?.storageKind === 'legacy-user-data-dir' ? manifest.vscodeCli : undefined),
    schemaVersion: 3,
  };
  writeProfileManifest(profileDir, next);
  return next;
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
export async function openProfile(name: string, extensionPath?: string, vscodeVersion = 'stable'): Promise<void> {
  const cwd = path.resolve(extensionPath ?? '.');
  const profileDir = getProfileDir(name, cwd);
  const isNew = !fs.existsSync(profileDir);
  const userDataDir = getProfileUserDataDir(profileDir);
  const extensionsDir = getProfileExtensionsDir(profileDir);
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(extensionsDir, { recursive: true });

  const vscodeCli = await resolveProfileRuntimeMetadata(vscodeVersion);

  const manifest = readProfileManifest(profileDir);
  warnForVSCodeDrift(manifest, vscodeCli);
  const profileManifest = markProfileAsUserDataDir(name, cwd, vscodeCli, new Date().toISOString());

  // If an extension path is provided, build it first so the profile gets the latest code
  if (extensionPath) {
    const resolved = path.resolve(extensionPath);
    buildExtension(resolved);
  }

  // Build launch args
  const args: string[] = [
    '--new-window',
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extensionsDir}`,
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
  ];

  if (extensionPath) {
    const resolved = path.resolve(extensionPath);
    args.push(`--extensionDevelopmentPath=${resolved}`);
  }

  if (isNew) {
    console.log(`\nCreated new profile "${name}":`);
  } else {
    console.log(`\nOpening existing profile "${name}":`);
  }
  console.log(`  ${profileDir}\n`);
  console.log(`Using VS Code test runtime: ${profileManifest.vscodeCli?.displayName ?? vscodeVersion} (${profileManifest.vscodeCli?.executablePath ?? profileManifest.vscodeCli?.command})`);

  // Launch VS Code - detached so the CLI can exit while VS Code stays open
  const proc = cp.spawn(vscodeCli.executablePath ?? vscodeCli.command, args, {
    stdio: 'ignore',
    detached: true,
    shell: false,
  });
  proc.unref();

  console.log('VS Code is opening. Authenticate, install extensions, or do whatever');
  console.log('preparation you need, then close the window when you\'re done.');
  console.log(`\nTo run tests with this profile later:`);
  console.log(`  vscode-ext-test run --test-id <slug> --reuse-named-profile ${name}\n`);
}

async function resolveProfileRuntimeMetadata(vscodeVersion: string): Promise<VSCodeCliMetadata> {
  const { download } = await import('@vscode/test-electron');
  const executablePath = await download({ version: vscodeVersion === 'stable' ? undefined : vscodeVersion });
  const versionInfo = getExecutableMetadata(executablePath);
  return {
    command: executablePath,
    displayName: vscodeVersion === 'insiders' ? 'VS Code Insiders Test Runtime' : 'VS Code Test Runtime',
    source: 'env',
    variant: vscodeVersion === 'insiders' ? 'insiders' : vscodeVersion === 'stable' ? 'stable' : 'custom',
    executablePath,
    ...versionInfo,
  };
}

function getExecutableMetadata(executablePath: string): { version?: string; commit?: string; architecture?: string } {
  try {
    const productJsonPath = path.join(path.dirname(executablePath), 'resources', 'app', 'product.json');
    const productJson = JSON.parse(fs.readFileSync(productJsonPath, 'utf-8')) as { version?: string; commit?: string };
    return { version: productJson.version, commit: productJson.commit, architecture: process.arch };
  } catch {
    return { architecture: process.arch };
  }
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
    return fs.statSync(full).isDirectory() && (fs.existsSync(path.join(full, 'profile.json')) || fs.existsSync(path.join(full, 'user-data')));
  });
}

export function collectProfileDoctorReports(names?: string[], cwd = process.cwd(), fix = false): ProfileDoctorReport[] {
  const currentCli = resolveVSCodeCli();
  const currentVSCode = currentCli ? getVSCodeCliMetadata(currentCli) : undefined;
  const profileNames = names && names.length > 0 ? names : listProfilesForCwd(cwd);

  return profileNames.map((name) => {
    const profileDir = getProfileDir(name, cwd);
    const userDataDir = getProfileUserDataDir(profileDir);
    const extensionsDir = getProfileExtensionsDir(profileDir);
    const nativeProfileName = getNativeVSCodeProfileName(name);

    if (fix) {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.mkdirSync(extensionsDir, { recursive: true });
    }

    const exists = fs.existsSync(profileDir);

    let manifest = readProfileManifest(profileDir);
    if (fix && currentVSCode) {
      writeProfileManifest(profileDir, {
        name,
        created: manifest?.created ?? new Date().toISOString(),
        lastOpened: manifest?.lastOpened,
        authStorageResetAt: manifest?.authStorageResetAt,
        nativeProfileName: manifest?.nativeProfileName,
        storageKind: manifest?.storageKind,
        vscodeCli: currentVSCode,
        schemaVersion: manifest?.schemaVersion ?? 2,
      });
      manifest = readProfileManifest(profileDir) ?? manifest;
    }

    const storageKind = getProfileStorageKind(manifest);
    const authUserDataDir = storageKind === 'native-vscode-profile'
      ? getVSCodeUserDataDir(currentVSCode) ?? userDataDir
      : userDataDir;

    let auth = inspectProfileAuthState(authUserDataDir);
    const repairs: string[] = [];
    if (fix && storageKind === 'legacy-user-data-dir' && shouldRepairSecretStorage(auth, manifest, userDataDir)) {
      const resetAt = new Date().toISOString();
      repairs.push(...repairProfileSecretStorage(profileDir, userDataDir, resetAt));
      writeProfileManifest(profileDir, {
        name,
        created: manifest?.created ?? new Date().toISOString(),
        lastOpened: manifest?.lastOpened,
        authStorageResetAt: resetAt,
        nativeProfileName: manifest?.nativeProfileName,
        storageKind: manifest?.storageKind,
        vscodeCli: currentVSCode ?? manifest?.vscodeCli,
        schemaVersion: 2,
      });
      manifest = readProfileManifest(profileDir) ?? manifest;
      auth = inspectProfileAuthState(userDataDir);
    }

    const report: ProfileDoctorReport = {
      name,
      profileDir,
      exists,
      userDataDir,
      userDataDirExists: fs.existsSync(userDataDir),
      extensionsDir,
      extensionsDirExists: fs.existsSync(extensionsDir),
      controllerInstalled: hasControllerExtension(extensionsDir),
      manifest: readProfileManifest(profileDir) ?? manifest,
      currentVSCode,
      nativeProfileName: manifest?.nativeProfileName ?? nativeProfileName,
      storageKind,
      auth,
      repairs,
      warnings: [],
      errors: [],
    };

    populateDoctorFindings(report);
    return report;
  });
}

export function printProfileDoctorReports(reports: ProfileDoctorReport[], json = false): void {
  if (json) {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }

  if (reports.length === 0) {
    console.log('No named profiles found.');
    return;
  }

  for (const report of reports) {
    console.log(`Profile: ${report.name}`);
    console.log(`  Path: ${report.profileDir}`);
    console.log(`  User data: ${report.userDataDirExists ? 'present' : 'missing'} (${report.userDataDir})`);
    console.log(`  Extensions: ${report.extensionsDirExists ? 'present' : 'missing'} (${report.extensionsDir})`);
    if (report.storageKind === 'native-vscode-profile') {
      console.log(`  Native VS Code profile: ${report.nativeProfileName}`);
    }
    console.log(`  Controller extension: ${formatControllerStatus(report)}`);
    console.log(`  Current VS Code: ${formatVSCodeSummary(report.currentVSCode)}`);
    console.log(`  Profile VS Code: ${formatVSCodeSummary(report.manifest?.vscodeCli)}`);
    console.log(
      `  GitHub auth markers: secret=${report.auth.githubAuthSecretMarkers}, ` +
      `github=${report.auth.githubAuthMentions}, loginAccount=${report.auth.loginAccountMentions}`
    );
    console.log(
      `  GitHub runtime auth: sessions=${report.auth.githubAuthLogLastSessionCount ?? 'unknown'}, ` +
      `loginSuccess=${report.auth.githubAuthLogLoginSuccess ? 'yes' : 'no'}, ` +
      `copilotToken=${report.auth.copilotTokenSeen ? 'yes' : 'no'}`
    );
    console.log(
      `  VS Code secret storage: decryptErrors=${report.auth.safeStorageDecryptErrors}` +
      `${report.auth.safeStorageDecryptLogPath ? ` (${report.auth.safeStorageDecryptLogPath})` : ''}`
    );
    for (const repair of report.repairs) {
      console.log(`  Fixed: ${repair}`);
    }
    for (const warning of report.warnings) {
      console.log(`  Warning: ${warning}`);
    }
    for (const error of report.errors) {
      console.log(`  Error: ${error}`);
    }
    console.log('');
  }
}

export function listProfilesForCwd(cwd = process.cwd()): string[] {
  const dir = path.resolve(cwd, PROFILES_DIR);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir).filter((entry) => {
    const full = path.join(dir, entry);
    return fs.statSync(full).isDirectory() && (fs.existsSync(path.join(full, 'profile.json')) || fs.existsSync(path.join(full, 'user-data')));
  });
}

export function getProfilePreferredVSCodeExecutable(name: string, cwd = process.cwd()): string | undefined {
  const manifest = readProfileManifest(getProfileDir(name, cwd));
  if (manifest?.storageKind !== 'legacy-user-data-dir') return undefined;
  const executablePath = manifest?.vscodeCli?.executablePath;
  return executablePath && fs.existsSync(executablePath) ? executablePath : undefined;
}

function isValidProfileName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name);
}

function inspectProfileAuthState(userDataDir: string): ProfileAuthStateSummary {
  const stateDbPath = path.join(userDataDir, 'User', 'globalStorage', 'state.vscdb');
  if (!fs.existsSync(stateDbPath)) {
    return {
      stateDbPath,
      stateDbExists: false,
      githubAuthSecretMarkers: 0,
      githubAuthMentions: 0,
      loginAccountMentions: 0,
      ...inspectGitHubRuntimeAuth(userDataDir),
    };
  }

  const text = fs.readFileSync(stateDbPath).toString('utf-8');
  return {
    stateDbPath,
    stateDbExists: true,
    githubAuthSecretMarkers: countAuthSecretMarkers(text, 'vscode.github-authentication'),
    githubAuthMentions: countRegex(text, /github(?:-authentication|\.auth)/g),
    loginAccountMentions: countOccurrences(text, 'loginAccount'),
    ...inspectGitHubRuntimeAuth(userDataDir),
  };
}

function populateDoctorFindings(report: ProfileDoctorReport): void {
  if (!report.exists) report.errors.push('Profile directory is missing.');
  if (report.storageKind === 'legacy-user-data-dir' && !report.userDataDirExists) report.errors.push('Profile user-data directory is missing.');
  if (report.storageKind === 'legacy-user-data-dir' && !report.extensionsDirExists) report.errors.push('Profile extensions directory is missing.');
  if (!report.currentVSCode) report.errors.push(formatVSCodeCliMissingMessage());
  if (!report.manifest?.vscodeCli) report.warnings.push('Profile has legacy metadata; run `vscode-ext-test profile doctor --fix` to stamp the current VS Code install.');
  if (report.manifest?.vscodeCli?.executablePath && !fs.existsSync(report.manifest.vscodeCli.executablePath)) {
    report.warnings.push(`Profile VS Code executable no longer exists: ${report.manifest.vscodeCli.executablePath}`);
  }
  if (report.currentVSCode && report.manifest?.vscodeCli) {
    if (normalizePath(report.currentVSCode.command) !== normalizePath(report.manifest.vscodeCli.command)) {
      report.warnings.push(`Profile was last opened with a different VS Code CLI: ${report.manifest.vscodeCli.command}`);
    }
    if (report.currentVSCode.version && report.manifest.vscodeCli.version && report.currentVSCode.version !== report.manifest.vscodeCli.version) {
      report.warnings.push(`Profile was last opened with VS Code ${report.manifest.vscodeCli.version}; current VS Code is ${report.currentVSCode.version}.`);
    }
  }
  if (!report.controllerInstalled && report.storageKind === 'legacy-user-data-dir') report.warnings.push('Controller extension is not installed in this profile extensions directory.');
  if (report.repairs.length > 0) {
    report.warnings.push('VS Code secret storage was reset for this profile. Open the profile and sign in to GitHub once so Copilot auth can be stored cleanly.');
  } else if (hasCurrentSafeStorageDecryptErrors(report)) {
    report.warnings.push('VS Code secret storage decrypt errors were found. GitHub/Copilot auth may not persist; run `vscode-ext-test profile doctor <name> --fix` to back up and reset this profile auth storage.');
  }
  if (report.auth.copilotPermissiveAuthErrorSeen) {
    report.warnings.push('Copilot reported that permissive GitHub authentication is required. Open the profile and accept the Copilot/GitHub permission prompt after signing in.');
  } else if (report.auth.copilotNotSignedInSeen) {
    report.warnings.push('Copilot reported that GitHub sign-in is missing for this profile.');
  }
  if (!hasGitHubAuthEvidence(report.auth, report.manifest)) {
    report.warnings.push('No GitHub/Copilot authentication session found for this profile. If this profile should use Copilot, open it and sign in to GitHub.');
  }
}

function getProfileStorageKind(manifest: ProfileManifest | undefined): 'native-vscode-profile' | 'legacy-user-data-dir' {
  return manifest?.storageKind === 'native-vscode-profile'
    ? 'native-vscode-profile'
    : 'legacy-user-data-dir';
}

function countAuthSecretMarkers(text: string, extensionId: string): number {
  return countOccurrences(text, `secret://{"extensionId":"${extensionId}"`) +
    countOccurrences(text, `secret://{\\"extensionId\\":\\"${extensionId}\\"`);
}

function hasGitHubAuthEvidence(auth: ProfileAuthStateSummary, manifest?: ProfileManifest): boolean {
  if (hasCurrentSafeStorageDecryptErrors({ auth, manifest })) return false;
  if (auth.copilotNotSignedInSeen || auth.copilotPermissiveAuthErrorSeen) return false;
  if (auth.githubAuthLogLastSessionCount !== undefined) return auth.githubAuthLogLastSessionCount > 0 || auth.copilotTokenSeen;
  return auth.githubAuthSecretMarkers > 0 || auth.copilotTokenSeen;
}

function inspectGitHubRuntimeAuth(userDataDir: string): Pick<ProfileAuthStateSummary,
  'githubAuthLogPath' |
  'githubAuthLogLastSessionCount' |
  'githubAuthLogLoginSuccess' |
  'copilotChatLogPath' |
  'copilotTokenSeen' |
  'copilotNotSignedInSeen' |
  'copilotPermissiveAuthErrorSeen' |
  'safeStorageDecryptErrors' |
  'safeStorageDecryptLogPath' |
  'safeStorageDecryptErrorMtimeMs'
> {
  const githubAuthLogPath = findLatestLogFile(userDataDir, 'GitHub Authentication.log');
  const copilotChatLogPath = findLatestLogFile(userDataDir, 'GitHub Copilot Chat.log');
  const githubAuthLogText = githubAuthLogPath ? readTailText(githubAuthLogPath) : '';
  const copilotChatLogText = copilotChatLogPath ? readTailText(copilotChatLogPath) : '';
  const safeStorage = inspectSafeStorageDecryptErrors(userDataDir);

  return {
    githubAuthLogPath,
    githubAuthLogLastSessionCount: getLastGitHubSessionCount(githubAuthLogText),
    githubAuthLogLoginSuccess: githubAuthLogText.includes('Login success!'),
    copilotChatLogPath,
    copilotTokenSeen: copilotChatLogText.includes('Got Copilot token') || copilotChatLogText.includes('Has token: true'),
    copilotNotSignedInSeen: copilotChatLogText.includes('You are not signed in to GitHub'),
    copilotPermissiveAuthErrorSeen: copilotChatLogText.includes('PermissiveAuthRequiredError') || copilotChatLogText.includes('Permissive authentication is required'),
    safeStorageDecryptErrors: safeStorage.count,
    safeStorageDecryptLogPath: safeStorage.path,
    safeStorageDecryptErrorMtimeMs: safeStorage.mtimeMs,
  };
}

function shouldRepairSecretStorage(auth: ProfileAuthStateSummary, manifest: ProfileManifest | undefined, userDataDir: string): boolean {
  if (!hasCurrentSafeStorageDecryptErrors({ auth, manifest })) return false;
  return fs.existsSync(path.join(userDataDir, 'Local State')) || fs.existsSync(auth.stateDbPath);
}

function hasCurrentSafeStorageDecryptErrors(report: Pick<ProfileDoctorReport, 'auth' | 'manifest'>): boolean {
  if (report.auth.safeStorageDecryptErrors === 0) return false;
  const resetAt = report.manifest?.authStorageResetAt ? Date.parse(report.manifest.authStorageResetAt) : Number.NaN;
  if (!Number.isFinite(resetAt)) return true;
  const errorMtime = report.auth.safeStorageDecryptErrorMtimeMs ?? 0;
  return errorMtime > resetAt;
}

function repairProfileSecretStorage(profileDir: string, userDataDir: string, resetAt: string): string[] {
  const backupRoot = path.join(profileDir, '.doctor-backups', resetAt.replace(/[:.]/g, '-'));
  const files = [
    path.join(userDataDir, 'Local State'),
    path.join(userDataDir, 'User', 'globalStorage', 'state.vscdb'),
    path.join(userDataDir, 'User', 'globalStorage', 'state.vscdb.backup'),
  ];

  const repairs: string[] = [];
  for (const filePath of files) {
    if (!fs.existsSync(filePath)) continue;
    const relative = path.relative(userDataDir, filePath);
    const backupPath = path.join(backupRoot, relative);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(filePath, backupPath);
    fs.rmSync(filePath, { force: true });
    repairs.push(`Backed up and reset ${relative}`);
  }
  return repairs;
}

function inspectSafeStorageDecryptErrors(userDataDir: string): { count: number; path?: string; mtimeMs?: number } {
  const logsDir = path.join(userDataDir, 'logs');
  if (!fs.existsSync(logsDir)) return { count: 0 };

  const logRoot = getLatestLogRoot(logsDir);

  let count = 0;
  let latest: { path: string; mtimeMs: number } | undefined;
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!entry.isFile() || (entry.name !== 'main.log' && entry.name !== 'renderer.log')) continue;
      const text = readTailText(full);
      const matches = countOccurrences(text, 'safeStorage.decryptString');
      if (matches === 0) continue;
      count += matches;
      const mtimeMs = fs.statSync(full).mtimeMs;
      if (!latest || mtimeMs > latest.mtimeMs) latest = { path: full, mtimeMs };
    }
  };
  visit(logRoot);
  return { count, path: latest?.path, mtimeMs: latest?.mtimeMs };
}

function getLatestLogRoot(logsDir: string): string {
  const roots = fs.readdirSync(logsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(logsDir, entry.name))
    .sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
  return roots[0] ?? logsDir;
}

function findLatestLogFile(userDataDir: string, fileName: string): string | undefined {
  const logsDir = path.join(userDataDir, 'logs');
  if (!fs.existsSync(logsDir)) return undefined;

  let latest: { path: string; mtimeMs: number } | undefined;
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile() && entry.name === fileName) {
        const mtimeMs = fs.statSync(full).mtimeMs;
        if (!latest || mtimeMs > latest.mtimeMs) latest = { path: full, mtimeMs };
      }
    }
  };
  visit(logsDir);
  return latest?.path;
}

function readTailText(filePath: string): string {
  try {
    const maxBytes = 512 * 1024;
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function getLastGitHubSessionCount(logText: string): number | undefined {
  let last: number | undefined;
  for (const match of logText.matchAll(/Got (\d+) (?:verified )?sessions? for/g)) {
    last = parseInt(match[1], 10);
  }
  return last;
}

function hasControllerExtension(extensionsDir: string): boolean {
  try {
    if (!fs.existsSync(extensionsDir)) return false;
    return fs.readdirSync(extensionsDir).some((entry) => {
      const packageJsonPath = path.join(extensionsDir, entry, 'package.json');
      try {
        const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { publisher?: string; name?: string };
        return `${manifest.publisher}.${manifest.name}` === CONTROLLER_EXTENSION_ID;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function warnForVSCodeDrift(manifest: ProfileManifest | undefined, current: VSCodeCliMetadata): void {
  if (!manifest?.vscodeCli) return;
  if (normalizePath(manifest.vscodeCli.command) !== normalizePath(current.command)) {
    console.warn(`Warning: profile was last opened with a different VS Code CLI: ${manifest.vscodeCli.command}`);
    console.warn(`Current VS Code CLI: ${current.command}`);
  }
  if (manifest.vscodeCli.version && current.version && manifest.vscodeCli.version !== current.version) {
    console.warn(`Warning: profile was last opened with VS Code ${manifest.vscodeCli.version}; current VS Code is ${current.version}.`);
  }
}

function formatVSCodeSummary(value: VSCodeCliMetadata | undefined): string {
  if (!value) return '<unknown>';
  const version = value.version ? ` ${value.version}` : '';
  return `${value.displayName}${version} (${value.command})`;
}

function formatControllerStatus(report: Pick<ProfileDoctorReport, 'storageKind' | 'controllerInstalled'>): string {
  if (report.storageKind === 'native-vscode-profile') return 'managed by native VS Code profile';
  return report.controllerInstalled ? 'present' : 'missing';
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  return text.split(needle).length - 1;
}

function countRegex(text: string, pattern: RegExp): number {
  return Array.from(text.matchAll(pattern)).length;
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
