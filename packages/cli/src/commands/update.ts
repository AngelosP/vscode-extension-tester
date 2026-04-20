import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cp from 'node:child_process';
import { getVsixPath } from './install.js';
import { listProfiles, getProfileDir, getProfileExtensionsDir } from '../profile.js';

const CONTROLLER_ID_PREFIX = 'vscode-extension-tester.vscode-extension-tester-controller';

/**
 * Update the controller extension in VS Code (global) and in every named
 * profile.  Removes the old extension folder, cleans extensions.json, and
 * reinstalls from the bundled VSIX.
 */
export async function updateCommand(): Promise<void> {
  const vsixPath = getVsixPath();
  const codeCmd = process.platform === 'win32' ? 'code.cmd' : 'code';
  let updated = 0;

  // 1. Global install
  console.log('Updating controller extension (global)...');
  try {
    cp.execSync(`${codeCmd} --install-extension "${vsixPath}" --force`, {
      stdio: 'inherit',
    });
    updated++;
  } catch {
    console.error('  Warning: global install failed.');
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
        console.log(`  Skipped — extensions directory does not exist.`);
        continue;
      }

      // Remove old controller extension folder(s)
      const entries = fs.readdirSync(extensionsDir);
      for (const entry of entries) {
        if (entry.startsWith(CONTROLLER_ID_PREFIX)) {
          const fullPath = path.join(extensionsDir, entry);
          fs.rmSync(fullPath, { recursive: true, force: true });
          console.log(`  Removed: ${entry}`);
        }
      }

      // Clean extensions.json
      const extJsonPath = path.join(extensionsDir, 'extensions.json');
      if (fs.existsSync(extJsonPath)) {
        try {
          const extJson = JSON.parse(fs.readFileSync(extJsonPath, 'utf-8'));
          if (Array.isArray(extJson)) {
            const filtered = extJson.filter(
              (e: any) => !e?.identifier?.id?.includes('vscode-extension-tester-controller'),
            );
            if (filtered.length !== extJson.length) {
              fs.writeFileSync(extJsonPath, JSON.stringify(filtered, null, '\t'), 'utf-8');
              console.log(`  Cleaned extensions.json`);
            }
          }
        } catch { /* non-fatal */ }
      }

      // Reinstall
      try {
        cp.execSync(
          `${codeCmd} --extensions-dir "${extensionsDir}" --install-extension "${vsixPath}" --force`,
          { stdio: 'pipe' },
        );
        // Verify
        const installed = fs.readdirSync(extensionsDir)
          .some(d => d.startsWith(CONTROLLER_ID_PREFIX));
        if (installed) {
          console.log(`  Installed.`);
          updated++;
        } else {
          console.error(`  Warning: install command ran but extension not found.`);
        }
      } catch (e: any) {
        console.error(`  Warning: install failed — ${e?.message ?? e}`);
      }
    }
  }

  console.log(`\nDone. Updated ${updated} location(s).`);
}
