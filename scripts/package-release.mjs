import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactsDir = join(root, 'release-artifacts');
const cliPackagePath = join(root, 'packages', 'cli', 'package.json');
const controllerVsixPath = join(root, 'packages', 'cli', 'assets', 'controller-extension.vsix');
const nativeBridgePath = join(root, 'packages', 'cli', 'assets', 'native', 'win-x64', 'FlaUIBridge.exe');

const cliPackage = JSON.parse(readFileSync(cliPackagePath, 'utf-8'));

assertExists(controllerVsixPath, 'controller extension VSIX');
assertExists(nativeBridgePath, 'native UI bridge executable');

rmSync(artifactsDir, { recursive: true, force: true });
mkdirSync(artifactsDir, { recursive: true });

runNpm(['pack', '-w', 'packages/cli', '--pack-destination', artifactsDir]);

const tarballName = `${cliPackage.name}-${cliPackage.version}.tgz`;
const tarballPath = join(artifactsDir, tarballName);
assertExists(tarballPath, 'npm package tarball');

const manifest = {
  package: cliPackage.name,
  version: cliPackage.version,
  tarball: tarballName,
  includes: {
    controllerExtension: 'assets/controller-extension.vsix',
    nativeBridge: 'assets/native/win-x64/FlaUIBridge.exe',
    nativeBridgeDirectory: 'assets/native/win-x64/',
  },
};
writeFileSync(join(artifactsDir, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const checksumLines = readdirSync(artifactsDir)
  .filter((fileName) => statSync(join(artifactsDir, fileName)).isFile())
  .sort()
  .map((fileName) => `${sha256(join(artifactsDir, fileName))}  ${fileName}`);
writeFileSync(join(artifactsDir, 'SHA256SUMS.txt'), `${checksumLines.join('\n')}\n`);

console.log(`Packaged ${tarballName} in ${artifactsDir}`);

function assertExists(filePath, label) {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

function sha256(filePath) {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}

function runNpm(args) {
  if (process.env.npm_execpath) {
    execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
      cwd: root,
      stdio: 'inherit',
    });
    return;
  }

  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}
