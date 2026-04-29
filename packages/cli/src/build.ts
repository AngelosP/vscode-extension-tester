import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cp from 'node:child_process';

export interface BuildExtensionOptions {
  readonly stdio?: 'inherit' | 'pipe-to-stderr';
}

/**
 * Build the extension under test so the latest compiled code is loaded.
 * Looks for `compile` (VS Code convention) or `build` scripts in the
 * extension's package.json.
 */
export function buildExtension(extensionPath: string, options: BuildExtensionOptions = {}): void {
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
  if (options.stdio === 'pipe-to-stderr') {
    const command = 'npm';
    const result = cp.spawnSync(command, ['run', scriptName], {
      cwd: extensionPath,
      encoding: 'utf-8',
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`npm run ${scriptName} failed with exit code ${result.status ?? 'unknown'}`);
    }
    console.log('Build complete.\n');
    return;
  }

  cp.execSync(`npm run ${scriptName}`, {
    cwd: extensionPath,
    stdio: 'inherit',
  });
  console.log('Build complete.\n');
}
