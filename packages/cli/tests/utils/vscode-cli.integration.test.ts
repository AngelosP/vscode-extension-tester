import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execVSCodeCliSync } from '../../src/utils/vscode-cli.js';

const tempDirs: string[] = [];
const windowsIt = process.platform === 'win32' ? it : it.skip;

describe('vscode-cli Windows command execution', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  windowsIt('executes a VS Code-style code.cmd from a path with spaces and preserves spaced args', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode cli spaced '));
    tempDirs.push(tempDir);

    const installRoot = path.join(tempDir, 'Microsoft VS Code');
    const binDir = path.join(installRoot, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const commandPath = path.join(binDir, 'code.cmd');
    createFakeVSCodeCli(installRoot);
    fs.writeFileSync(commandPath, fakeCodeCmdContent(), 'utf-8');

    const vsixPath = path.join(tempDir, 'controller extension.vsix');
    fs.writeFileSync(vsixPath, '', 'utf-8');

    const output = execVSCodeCliSync({
      command: commandPath,
      displayName: 'VS Code',
      source: 'standard-location',
      variant: 'stable',
      requiresShell: true,
    }, ['--install-extension', vsixPath, '--force'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    expect(String(output)).toContain('arg1=--install-extension');
    expect(String(output)).toContain(`arg2=${vsixPath}`);
    expect(String(output)).toContain('arg3=--force');
  });

  windowsIt('preserves literal percent signs in args passed through code.cmd', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode cli percent '));
    tempDirs.push(tempDir);

    const installRoot = path.join(tempDir, 'Microsoft VS Code');
    const binDir = path.join(installRoot, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const commandPath = path.join(binDir, 'code.cmd');
    createFakeVSCodeCli(installRoot);
    fs.writeFileSync(commandPath, fakeCodeCmdContent(), 'utf-8');

    const vsixPath = path.join(tempDir, 'literal %TEMP% controller.vsix');
    fs.writeFileSync(vsixPath, '', 'utf-8');

    const output = execVSCodeCliSync({
      command: commandPath,
      displayName: 'VS Code',
      source: 'standard-location',
      variant: 'stable',
      requiresShell: true,
    }, ['--install-extension', vsixPath, '--force'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    expect(String(output)).toContain(`arg2=${vsixPath}`);
  });
});

function createFakeVSCodeCli(root: string): string {
  const cliDir = path.join(root, 'commit', 'resources', 'app', 'out');
  fs.mkdirSync(cliDir, { recursive: true });
  const cliJs = path.join(cliDir, 'cli.js');
  fs.writeFileSync(cliJs, [
    'console.log(`arg1=${process.argv[2] ?? ""}`);',
    'console.log(`arg2=${process.argv[3] ?? ""}`);',
    'console.log(`arg3=${process.argv[4] ?? ""}`);',
  ].join('\n'), 'utf-8');
  return cliJs;
}

function fakeCodeCmdContent(): string {
  return [
    '@echo off',
    'setlocal',
    'set VSCODE_DEV=',
    'set ELECTRON_RUN_AS_NODE=1',
    `"${process.execPath}" "%~dp0..\\commit\\resources\\app\\out\\cli.js" %*`,
    'IF %ERRORLEVEL% NEQ 0 EXIT /b %ERRORLEVEL%',
    'endlocal',
  ].join('\r\n');
}
