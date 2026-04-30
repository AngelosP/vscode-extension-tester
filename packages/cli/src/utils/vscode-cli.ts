import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type VSCodeCliSource = 'env' | 'path' | 'standard-location';
export type VSCodeCliVariant = 'stable' | 'insiders' | 'custom';

export interface ResolvedVSCodeCli {
  command: string;
  displayName: string;
  source: VSCodeCliSource;
  variant: VSCodeCliVariant;
  requiresShell: boolean;
}

export interface ResolveVSCodeCliOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

interface VSCodeNodeCli {
  executable: string;
  cliJs: string;
}

const ENV_OVERRIDE = 'VSCODE_EXT_TEST_CODE';

/**
 * Resolve the VS Code CLI from an explicit override, PATH, or standard install locations.
 */
export function resolveVSCodeCli(options: ResolveVSCodeCliOptions = {}): ResolvedVSCodeCli | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const envLookup = platform === 'win32' ? buildCaseInsensitiveEnvLookup(env) : null;

  const overrideValue = envLookup?.get(ENV_OVERRIDE.toLowerCase()) ?? env[ENV_OVERRIDE];
  const override = stripWrappingQuotes(overrideValue?.trim() ?? '');
  if (override) {
    const resolvedOverride = resolveOverride(override, platform, env);
    if (resolvedOverride) return resolvedOverride;
    return null;
  }

  for (const candidate of getPathCandidates(platform)) {
    const resolved = findCommandOnPath(candidate.command, platform, env);
    if (resolved) {
      return toResolvedCli(resolved, 'path', candidate.variant, platform);
    }
  }

  if (platform === 'win32') {
    for (const candidate of getWindowsStandardLocationCandidates(env)) {
      if (fs.existsSync(candidate.command)) {
        return toResolvedCli(candidate.command, 'standard-location', candidate.variant, platform);
      }
    }
  }

  return null;
}

export function execVSCodeCliSync(
  cli: ResolvedVSCodeCli,
  args: readonly string[],
  options: cp.ExecFileSyncOptions = {},
): string | Buffer {
  if (cli.requiresShell) {
    const nodeCli = resolveVSCodeNodeCli(cli.command);
    if (nodeCli) {
      return cp.execFileSync(nodeCli.executable, [nodeCli.cliJs, ...args], {
        ...options,
        env: buildVSCodeNodeCliEnv(options.env),
        shell: false,
      } as cp.ExecFileSyncOptions) as string | Buffer;
    }

    assertSafeWindowsBatchFallbackValues(cli.command, args);

    return cp.execFileSync(getWindowsCommandShell(), buildWindowsCommandShellArgs(cli.command, args), {
      ...options,
      shell: false,
      windowsVerbatimArguments: true,
    } as cp.ExecFileSyncOptions) as string | Buffer;
  }

  return cp.execFileSync(cli.command, [...args], {
    ...options,
    shell: options.shell ?? false,
  } as cp.ExecFileSyncOptions) as string | Buffer;
}

export function spawnVSCodeCli(
  cli: ResolvedVSCodeCli,
  args: readonly string[],
  options: cp.SpawnOptions = {},
): cp.ChildProcess {
  if (cli.requiresShell) {
    const nodeCli = resolveVSCodeNodeCli(cli.command);
    if (nodeCli) {
      return cp.spawn(nodeCli.executable, [nodeCli.cliJs, ...args], {
        ...options,
        env: buildVSCodeNodeCliEnv(options.env),
        shell: false,
      });
    }

    assertSafeWindowsBatchFallbackValues(cli.command, args);

    return cp.spawn(getWindowsCommandShell(), buildWindowsCommandShellArgs(cli.command, args), {
      ...options,
      shell: false,
      windowsVerbatimArguments: true,
    });
  }

  return cp.spawn(cli.command, [...args], {
    ...options,
    shell: options.shell ?? false,
  });
}

export function formatVSCodeCliMissingMessage(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return [
      'VS Code CLI not found.',
      'Install VS Code, add its bin directory to PATH, or set VSCODE_EXT_TEST_CODE to your VS Code CLI path.',
      `Common value: ${ENV_OVERRIDE}=%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\bin\\code.cmd`,
    ].join('\n');
  }

  return [
    'VS Code CLI not found.',
    'Install the `code` command in PATH, or set VSCODE_EXT_TEST_CODE to your VS Code CLI path.',
  ].join('\n');
}

function resolveOverride(command: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ResolvedVSCodeCli | null {
  const expandedCommand = platform === 'win32' ? expandWindowsEnvReferences(command, env) : command;

  if (isPathLike(expandedCommand)) {
    const resolvedPath = platform === 'win32' ? preferWindowsBatchSibling(expandedCommand) : expandedCommand;
    if (!fs.existsSync(resolvedPath)) return null;
    return toResolvedCli(resolvedPath, 'env', inferVariant(resolvedPath), platform);
  }

  const resolved = findCommandOnPath(expandedCommand, platform, env);
  if (!resolved) return null;
  return toResolvedCli(resolved, 'env', inferVariant(expandedCommand), platform);
}

function getPathCandidates(platform: NodeJS.Platform): Array<{ command: string; variant: VSCodeCliVariant }> {
  if (platform === 'win32') {
    return [
      { command: 'code.cmd', variant: 'stable' },
      { command: 'code', variant: 'stable' },
      { command: 'code-insiders.cmd', variant: 'insiders' },
      { command: 'code-insiders', variant: 'insiders' },
    ];
  }

  return [
    { command: 'code', variant: 'stable' },
    { command: 'code-insiders', variant: 'insiders' },
  ];
}

function getWindowsStandardLocationCandidates(env: NodeJS.ProcessEnv): Array<{ command: string; variant: VSCodeCliVariant }> {
  const candidates: Array<{ command: string; variant: VSCodeCliVariant }> = [];
  const envLookup = buildCaseInsensitiveEnvLookup(env);

  for (const base of [envLookup.get('localappdata'), envLookup.get('programfiles'), envLookup.get('programfiles(x86)')]) {
    if (!base) continue;
    candidates.push(
      { command: path.win32.join(base, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'), variant: 'stable' },
      { command: path.win32.join(base, 'Programs', 'Microsoft VS Code Insiders', 'bin', 'code-insiders.cmd'), variant: 'insiders' },
      { command: path.win32.join(base, 'Microsoft VS Code', 'bin', 'code.cmd'), variant: 'stable' },
      { command: path.win32.join(base, 'Microsoft VS Code Insiders', 'bin', 'code-insiders.cmd'), variant: 'insiders' },
    );
  }

  return candidates;
}

function findCommandOnPath(command: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | null {
  const lookupCommand = getPathLookupCommand(platform);
  try {
    const output = cp.execFileSync(lookupCommand, [command], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env,
    }) as unknown as string;
    const results = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (platform === 'win32') {
      const executable = results.find((line) => /\.(?:cmd|bat|exe)$/i.test(line));
      if (executable) return executable;
      if (/^code(?:-insiders)?$/i.test(command)) return null;
      return results[0] ?? null;
    }
    return results[0] ?? null;
  } catch {
    return null;
  }
}

function getPathLookupCommand(platform: NodeJS.Platform): string {
  if (platform !== 'win32') return 'which';
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  return systemRoot ? path.win32.join(systemRoot, 'System32', 'where.exe') : 'where.exe';
}

function toResolvedCli(
  command: string,
  source: VSCodeCliSource,
  variant: VSCodeCliVariant,
  platform: NodeJS.Platform,
): ResolvedVSCodeCli {
  return {
    command,
    displayName: variant === 'insiders' ? 'VS Code Insiders' : variant === 'stable' ? 'VS Code' : 'VS Code CLI',
    source,
    variant,
    requiresShell: requiresShell(command, platform),
  };
}

function requiresShell(command: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && /\.(?:cmd|bat)$/i.test(command);
}

function preferWindowsBatchSibling(command: string): string {
  if (/\.(?:cmd|bat|exe)$/i.test(command)) return command;
  const basename = path.win32.basename(command).toLowerCase();
  if (basename !== 'code' && basename !== 'code-insiders') return command;

  for (const extension of ['.cmd', '.bat']) {
    const candidate = `${command}${extension}`;
    if (fs.existsSync(candidate)) return candidate;
  }
  return command;
}

function resolveVSCodeNodeCli(command: string): VSCodeNodeCli | null {
  if (!/^code(?:-insiders)?\.cmd$/i.test(path.basename(command))) return null;

  let content: string;
  try {
    content = fs.readFileSync(command, 'utf-8');
  } catch {
    return null;
  }

  const quotedValues = Array.from(content.matchAll(/"([^"]+)"/g), (match) => match[1]);
  const executableToken = quotedValues.find((value) => /\.exe$/i.test(value));
  const cliJsToken = quotedValues.find((value) => /(?:^|[\\/])cli\.js$/i.test(value));
  if (!executableToken || !cliJsToken) return null;

  const executable = resolveCodeCmdToken(command, executableToken);
  const cliJs = resolveCodeCmdToken(command, cliJsToken);
  if (!fs.existsSync(executable) || !fs.existsSync(cliJs)) return null;

  return { executable, cliJs };
}

function resolveCodeCmdToken(command: string, token: string): string {
  const commandDir = path.dirname(command);
  const expanded = token.replace(/%~dp0/ig, commandDir + path.sep);
  return path.resolve(commandDir, expanded);
}

function buildVSCodeNodeCliEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...env,
    VSCODE_DEV: '',
    ELECTRON_RUN_AS_NODE: '1',
  };
}

function getWindowsCommandShell(): string {
  return process.env.ComSpec || 'cmd.exe';
}

function buildWindowsCommandShellArgs(command: string, args: readonly string[]): string[] {
  const commandLine = ['call', command, ...args].map((value, index) => (
    index === 0 ? value : quoteWindowsCommandLineArg(value)
  )).join(' ');
  return ['/d', '/s', '/c', commandLine];
}

function quoteWindowsCommandLineArg(value: string): string {
  return `"${value.replace(/["^&|<>]/g, (char) => `^${char}`)}"`;
}

function assertSafeWindowsBatchFallbackValues(command: string, args: readonly string[]): void {
  if ([command, ...args].some((value) => value.includes('%'))) {
    throw new Error('Cannot safely pass percent signs through a non-VS Code batch wrapper. Use a standard VS Code code.cmd path or remove percent signs from the path.');
  }
}

function inferVariant(command: string): VSCodeCliVariant {
  const lower = command.toLowerCase();
  if (lower.includes('insiders')) return 'insiders';
  if (lower.includes('code')) return 'stable';
  return 'custom';
}

function isPathLike(command: string): boolean {
  return path.isAbsolute(command) || command.includes('/') || command.includes('\\');
}

function stripWrappingQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function expandWindowsEnvReferences(value: string, env: NodeJS.ProcessEnv): string {
  const envLookup = buildCaseInsensitiveEnvLookup(env);
  return value.replace(/%([^%]+)%/g, (match, name: string) => envLookup.get(name.toLowerCase()) ?? match);
}

function buildCaseInsensitiveEnvLookup(env: NodeJS.ProcessEnv): Map<string, string | undefined> {
  return new Map(Object.entries(env).map(([key, envValue]) => [key.toLowerCase(), envValue]));
}
