import * as fs from 'node:fs';
import * as path from 'node:path';
import { getVsixPath } from './install.js';
import { listProfiles, getProfileDir, getProfileExtensionsDir } from '../profile.js';
import { CONTROLLER_EXTENSION_ID } from '../types.js';
import { execVSCodeCliSync, formatVSCodeCliMissingMessage, resolveVSCodeCli, type ResolvedVSCodeCli } from '../utils/vscode-cli.js';

const CONTROLLER_ID_PREFIX = 'vscode-extension-tester.vscode-extension-tester-controller';

interface ControllerBackup {
  root: string;
  entries: string[];
  extensionsJsonBackedUp: boolean;
}

/**
 * Update the controller extension in VS Code (global) and in every named
 * profile by reinstalling from the bundled VSIX with --force.
 */
export async function updateCommand(): Promise<void> {
  const vsixPath = getVsixPath();
  const codeCli = resolveVSCodeCli();
  let updated = 0;
  let hadFailure = false;

  if (!codeCli) {
    console.error('Cannot update controller extension automatically.');
    console.error(formatVSCodeCliMissingMessage());
    process.exitCode = 1;
    return;
  }

  // 1. Global install
  console.log('Updating controller extension (global)...');
  try {
    execVSCodeCliSync(codeCli, ['--install-extension', vsixPath, '--force'], {
      stdio: 'inherit',
    });
    updated++;
  } catch {
    console.error('  Warning: global install failed.');
    hadFailure = true;
  }

  // 2. Update every named profile
  const profiles = listProfiles();
  if (profiles.length === 0) {
    console.log('\nNo named profiles found.');
  } else {
    console.log(`\nFound ${profiles.length} named profile(s).\n`);
    for (const name of profiles) {
      console.log(`Updating profile "${name}"...`);
      const profileDir = getProfileDir(name);
      const extensionsDir = getProfileExtensionsDir(profileDir);

      if (!fs.existsSync(extensionsDir)) {
        fs.mkdirSync(extensionsDir, { recursive: true });
      }

      // Reinstall
      try {
        verifyControllerInstallInTempDir(codeCli, vsixPath, extensionsDir);
        const backup = quarantineControllerExtensionFolders(extensionsDir);
        try {
          execVSCodeCliSync(codeCli, ['--extensions-dir', extensionsDir, '--install-extension', vsixPath, '--force'], {
            stdio: 'pipe',
          });
          if (!hasControllerExtension(extensionsDir)) {
            throw new Error('install command ran but extension not found');
          }
          cleanStaleControllerMetadata(extensionsDir);
        } catch (error) {
          restoreControllerBackup(backup, extensionsDir);
          throw error;
        }
        discardControllerBackup(backup);

        // Verify
        const installed = hasControllerExtension(extensionsDir);
        if (installed) {
          console.log(`  Installed.`);
          updated++;
        } else {
          console.error(`  Warning: install command ran but extension not found.`);
          hadFailure = true;
        }
      } catch (e: any) {
        console.error(`  Warning: install failed — ${e?.message ?? e}`);
        hadFailure = true;
      }
    }
  }

  if (hadFailure) {
    process.exitCode = 1;
  }

  console.log(`\nDone. Updated ${updated} location(s).`);
}

function hasControllerExtension(extensionsDir: string): boolean {
  return getControllerExtensionFolders(extensionsDir).some((entry) => isUsableControllerExtensionFolder(extensionsDir, entry));
}

function getControllerExtensionFolders(extensionsDir: string): string[] {
  return fs.readdirSync(extensionsDir)
    .filter((entry) => entry.startsWith(CONTROLLER_ID_PREFIX) || isUsableControllerExtensionFolder(extensionsDir, entry));
}

function isUsableControllerExtensionFolder(extensionsDir: string, entry: string): boolean {
  const packageJsonPath = path.join(extensionsDir, entry, 'package.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { publisher?: string; name?: string };
    return `${manifest.publisher}.${manifest.name}` === CONTROLLER_EXTENSION_ID;
  } catch {
    return false;
  }
}

function verifyControllerInstallInTempDir(codeCli: ResolvedVSCodeCli, vsixPath: string, extensionsDir: string): void {
  const probeExtensionsDir = fs.mkdtempSync(path.join(path.dirname(extensionsDir), '.controller-probe-'));
  try {
    execVSCodeCliSync(codeCli, ['--extensions-dir', probeExtensionsDir, '--install-extension', vsixPath, '--force'], {
      stdio: 'pipe',
    });
    if (!hasControllerExtension(probeExtensionsDir)) {
      throw new Error('install probe ran but extension was not found');
    }
  } finally {
    fs.rmSync(probeExtensionsDir, { recursive: true, force: true });
  }
}

function quarantineControllerExtensionFolders(extensionsDir: string): ControllerBackup {
  const backupRoot = fs.mkdtempSync(path.join(path.dirname(extensionsDir), '.controller-backup-'));
  const entries: string[] = [];
  const extensionsJsonPath = path.join(extensionsDir, 'extensions.json');
  const backupExtensionsJsonPath = path.join(backupRoot, 'extensions.json');
  let extensionsJsonBackedUp = false;

  try {
    if (fs.existsSync(extensionsJsonPath)) {
      fs.copyFileSync(extensionsJsonPath, backupExtensionsJsonPath);
      extensionsJsonBackedUp = true;
    }

    for (const entry of getControllerExtensionFolders(extensionsDir)) {
      fs.renameSync(path.join(extensionsDir, entry), path.join(backupRoot, entry));
      console.log(`  Moved stale install aside: ${entry}`);
      entries.push(entry);
    }
  } catch (error) {
    restoreQuarantineBackup({ root: backupRoot, entries, extensionsJsonBackedUp }, extensionsDir);
    throw error;
  }

  return { root: backupRoot, entries, extensionsJsonBackedUp };
}

function restoreControllerBackup(backup: ControllerBackup, extensionsDir: string): void {
  for (const entry of getControllerExtensionFolders(extensionsDir)) {
    fs.rmSync(path.join(extensionsDir, entry), { recursive: true, force: true });
  }

  for (const entry of backup.entries) {
    const target = path.join(extensionsDir, entry);
    fs.renameSync(path.join(backup.root, entry), target);
    console.log(`  Restored previous install: ${entry}`);
  }

  const extensionsJsonPath = path.join(extensionsDir, 'extensions.json');
  const backupExtensionsJsonPath = path.join(backup.root, 'extensions.json');
  if (backup.extensionsJsonBackedUp) {
    fs.copyFileSync(backupExtensionsJsonPath, extensionsJsonPath);
  } else {
    fs.rmSync(extensionsJsonPath, { force: true });
  }

  fs.rmSync(backup.root, { recursive: true, force: true });
}

function discardControllerBackup(backup: ControllerBackup): void {
  try {
    fs.rmSync(backup.root, { recursive: true, force: true });
  } catch (error) {
    console.warn(`  Warning: could not remove backup directory ${backup.root}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function restoreQuarantineBackup(backup: ControllerBackup, extensionsDir: string): void {
  for (const entry of backup.entries) {
    const target = path.join(extensionsDir, entry);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(path.join(backup.root, entry), target);
    console.log(`  Restored previous install: ${entry}`);
  }

  const extensionsJsonPath = path.join(extensionsDir, 'extensions.json');
  const backupExtensionsJsonPath = path.join(backup.root, 'extensions.json');
  if (backup.extensionsJsonBackedUp) {
    fs.copyFileSync(backupExtensionsJsonPath, extensionsJsonPath);
  }

  fs.rmSync(backup.root, { recursive: true, force: true });
}

function cleanStaleControllerMetadata(extensionsDir: string): void {
  const extensionsJsonPath = path.join(extensionsDir, 'extensions.json');
  if (!fs.existsSync(extensionsJsonPath)) return;

  let entries: unknown;
  try {
    entries = JSON.parse(fs.readFileSync(extensionsJsonPath, 'utf-8'));
  } catch {
    return;
  }
  if (!Array.isArray(entries)) return;

  const filtered = entries.filter((entry) => !isStaleControllerMetadataEntry(entry, extensionsDir));
  if (filtered.length !== entries.length) {
    fs.writeFileSync(extensionsJsonPath, JSON.stringify(filtered, null, '\t'), 'utf-8');
  }
}

function isStaleControllerMetadataEntry(entry: unknown, extensionsDir: string): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const value = entry as {
    identifier?: { id?: unknown };
    relativeLocation?: unknown;
    location?: { path?: unknown; fsPath?: unknown };
  };
  const id = typeof value.identifier?.id === 'string' ? value.identifier.id.toLowerCase() : '';
  if (id !== CONTROLLER_EXTENSION_ID) return false;

  if (typeof value.relativeLocation === 'string' && value.relativeLocation.length > 0) {
    return !fs.existsSync(path.join(extensionsDir, value.relativeLocation));
  }

  const locations = [value.location?.fsPath, value.location?.path]
    .filter((location): location is string => typeof location === 'string' && location.length > 0)
    .map((location) => normalizeMetadataLocation(location, extensionsDir));

  return locations.length > 0 && locations.every((location) => !fs.existsSync(location));
}

function normalizeMetadataLocation(location: string, extensionsDir: string): string {
  if (process.platform === 'win32' && /^\/[a-zA-Z]:[\\/]/.test(location)) {
    return location.slice(1);
  }
  return path.isAbsolute(location) ? location : path.join(extensionsDir, location);
}
