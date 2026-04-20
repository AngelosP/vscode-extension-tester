import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cp from 'node:child_process';

/**
 * Build the extension under test so the latest compiled code is loaded.
 * Looks for `compile` (VS Code convention) or `build` scripts in the
 * extension's package.json.
 */
export function buildExtension(extensionPath: string): void {
  const pkgPath = path.join(extensionPath, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return;
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const scripts: Record<string, string> = pkg.scripts ?? {};

  // Prefer 'compile' (VS Code convention), then 'build'
  const scriptName = scripts['compile'] ? 'compile' : scripts['build'] ? 'build' : null;
  if (!scriptName) {
    return;
  }

  console.log(`Building extension (npm run ${scriptName})...`);
  cp.execSync(`npm run ${scriptName}`, {
    cwd: extensionPath,
    stdio: 'inherit',
  });
  console.log('Build complete.\n');
}
