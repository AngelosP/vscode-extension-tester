import * as vscode from 'vscode';
import { WSServer } from './ws-server.js';
import { CommandExecutor } from './command-executor.js';
import { UIInterceptor } from './ui-interceptor.js';
import { StateReader } from './state-reader.js';
import { OutputMonitor } from './output-monitor.js';
import { AuthHandler } from './auth-handler.js';
import { registerDebugConfigProvider } from './debug-config-provider.js';

let server: WSServer | undefined;
const envPort = process.env['VSCODE_EXT_TESTER_PORT'];

// Create the output monitor early but defer register() to activate() where
// we have proper disposable lifecycle.  The document-change listener doesn't
// need module-level patching — it uses VS Code's shared workspace API.
const outputMonitor = envPort ? new OutputMonitor() : undefined;
const log = vscode.window.createOutputChannel('Extension Tester Controller');

/** Helper: write to both the VS Code channel AND the monitor buffer directly. */
function logLine(msg: string): void {
  log.appendLine(msg);
  outputMonitor?.appendContent('Extension Tester Controller', msg + '\n');
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  registerDebugConfigProvider(context);

  if (!envPort) {
    log.appendLine('[activate] VSCODE_EXT_TESTER_PORT not set - standby mode');
    return;
  }

  // Register output monitor listeners (uses workspace.onDidChangeTextDocument
  // which works across all extensions).
  context.subscriptions.push(...outputMonitor!.register());

  const port = parseInt(envPort, 10);
  logLine(`[activate] Starting WebSocket server on port ${port}...`);

  try {
    const commandExecutor = new CommandExecutor();
    const uiInterceptor = new UIInterceptor();
    const stateReader = new StateReader();
    const authHandler = new AuthHandler();

    server = new WSServer(port, {
      commandExecutor,
      uiInterceptor,
      stateReader,
      outputMonitor: outputMonitor!,
      authHandler,
    });

    await server.start();
    logLine(`[activate] WebSocket server started on port ${port}`);

    context.subscriptions.push(
      { dispose: () => server?.stop() },
      ...uiInterceptor.register(),
      ...authHandler.register(),
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logLine(`[activate] ERROR: ${msg}`);
  }
}

export function deactivate(): void {
  server?.stop();
}
