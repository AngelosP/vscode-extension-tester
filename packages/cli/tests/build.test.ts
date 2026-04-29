import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildExtension } from '../src/build.js';

const tempDirs: string[] = [];

function makeExtensionWithScript(script: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-ext-test-build-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { compile: script } }, null, 2));
  return dir;
}

describe('buildExtension', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should pipe child build stdout and stderr to stderr when requested', () => {
    const extensionDir = makeExtensionWithScript('node -e "process.stdout.write(\'child-out\'); process.stderr.write(\'child-err\')"');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    buildExtension(extensionDir, { stdio: 'pipe-to-stderr' });

    const writes = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(writes).toContain('child-out');
    expect(writes).toContain('child-err');
  });
});
