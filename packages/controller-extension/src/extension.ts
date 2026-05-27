import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WSServer } from './ws-server.js';
import { CommandExecutor } from './command-executor.js';
import { UIInterceptor } from './ui-interceptor.js';
import { StateReader } from './state-reader.js';
import { OutputMonitor } from './output-monitor.js';
import { AuthHandler } from './auth-handler.js';
import { registerDebugConfigProvider } from './debug-config-provider.js';

let server: WSServer | undefined;
let serverPort: number | undefined;
let launchRequestWatcher: NodeJS.Timeout | undefined;

let outputMonitor: OutputMonitor | undefined;
const log = vscode.window.createOutputChannel('Extension Tester Controller');

/** Helper: write to both the VS Code channel AND the monitor buffer directly. */
function logLine(msg: string): void {
  log.appendLine(msg);
  outputMonitor?.appendContent('Extension Tester Controller', msg + '\n');
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  registerDebugConfigProvider(context);
  startLaunchRequestWatcher(context);

  const portInfo = resolveControllerPort();
  if (!portInfo) {
    log.appendLine('[activate] No controller launch request found - standby mode');
    return;
  }

  await startController(context, portInfo.port, portInfo.source);
}

async function startController(context: vscode.ExtensionContext, port: number, source: string): Promise<void> {
  if (server) {
    if (serverPort === port) return;
    logLine(`[activate] Restarting WebSocket server on port ${port} (${source}); previous port was ${serverPort}`);
    stopController();
  }

  outputMonitor = new OutputMonitor();
  context.subscriptions.push(...outputMonitor.register());

  logLine(`[activate] Starting WebSocket server on port ${port} (${source})...`);

  try {
    const commandExecutor = new CommandExecutor();
    const stateReader = new StateReader();
    const uiInterceptor = new UIInterceptor();
    const authHandler = new AuthHandler();

    const nextServer = new WSServer(port, {
      commandExecutor,
      uiInterceptor,
      stateReader,
      outputMonitor,
      authHandler,
      onCloseWindow: () => stopController(),
    });

    await nextServer.start();
    server = nextServer;
    serverPort = port;
    logLine(`[activate] WebSocket server started on port ${port}`);

    context.subscriptions.push(
      { dispose: stopController },
      ...stateReader.register(),
      ...uiInterceptor.register(),
      ...authHandler.register(),
    );
  } catch (err: unknown) {
    server = undefined;
    serverPort = undefined;
    const msg = err instanceof Error ? err.message : String(err);
    logLine(`[activate] ERROR: ${msg}`);
  }
}

export function deactivate(): void {
  stopLaunchRequestWatcher();
  stopController();
}

function stopController(): void {
  server?.stop();
  server = undefined;
  serverPort = undefined;
}

function resolveControllerPort(): { port: number; source: string } | undefined {
  const envPort = parsePort(process.env['VSCODE_EXT_TESTER_PORT']);
  if (envPort) return { port: envPort, source: 'VSCODE_EXT_TESTER_PORT' };

  const launchRequestPort = readLaunchRequestPort();
  if (launchRequestPort) return { port: launchRequestPort, source: 'launch request' };

  const configuredPort = readExplicitConfiguredPort();
  if (configuredPort) return { port: configuredPort, source: 'extension setting' };

  return undefined;
}

function readLaunchRequestPort(): number | undefined {
  const requestPath = path.join(os.tmpdir(), 'vscode-extension-tester-controller-launch.json');
  try {
    if (!fs.existsSync(requestPath)) return undefined;
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf-8')) as { port?: unknown; expiresAt?: unknown; workspacePath?: unknown };
    if (typeof request.expiresAt !== 'number' || request.expiresAt < Date.now()) return undefined;
    if (typeof request.workspacePath === 'string' && !matchesCurrentWorkspace(request.workspacePath)) return undefined;
    return parsePort(request.port);
  } catch {
    return undefined;
  }
}

function matchesCurrentWorkspace(requestWorkspacePath: string): boolean {
  const expected = normalizePath(requestWorkspacePath);
  if (!expected) return false;

  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of workspaceFolders) {
    const actual = normalizePath(folder.uri.fsPath);
    if (!actual) continue;
    if (actual === expected || actual.startsWith(`${expected}${path.sep}`)) return true;
  }

  const workspaceFile = vscode.workspace.workspaceFile?.fsPath;
  return normalizePath(workspaceFile) === expected;
}

function normalizePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return path.resolve(value).toLowerCase();
}

function startLaunchRequestWatcher(context: vscode.ExtensionContext): void {
  if (launchRequestWatcher) return;
  launchRequestWatcher = setInterval(() => {
    const port = readLaunchRequestPort();
    if (!port) return;
    void startController(context, port, 'launch request');
  }, 500);
  context.subscriptions.push({ dispose: stopLaunchRequestWatcher });
}

function stopLaunchRequestWatcher(): void {
  if (!launchRequestWatcher) return;
  clearInterval(launchRequestWatcher);
  launchRequestWatcher = undefined;
}

function readExplicitConfiguredPort(): number | undefined {
  const inspected = vscode.workspace.getConfiguration('extensionTester').inspect<number>('controllerPort');
  return parsePort(
    inspected?.workspaceFolderValue ??
    inspected?.workspaceValue ??
    inspected?.globalValue,
  );
}

function parsePort(value: unknown): number | undefined {
  const port = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}
