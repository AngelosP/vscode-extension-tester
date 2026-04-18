import * as vscode from 'vscode';
import { WSServer } from './ws-server.js';
import { CommandExecutor } from './command-executor.js';
import { UIInterceptor } from './ui-interceptor.js';
import { StateReader } from './state-reader.js';
import { OutputMonitor } from './output-monitor.js';
import { AuthHandler } from './auth-handler.js';

let server: WSServer | undefined;
const log = vscode.window.createOutputChannel('Extension Tester Controller');

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Only start the WS server if VSCODE_EXT_TESTER_PORT is set.
  // This env var is set in the "Debug extension with automation support" launch config
  // that init creates. It ensures the server only runs in the Dev Host, not the main window.
  const envPort = process.env['VSCODE_EXT_TESTER_PORT'];
  if (!envPort) {
    log.appendLine('[activate] VSCODE_EXT_TESTER_PORT not set — standby mode');
    return;
  }

  const port = parseInt(envPort, 10);
  log.appendLine(`[activate] Starting WebSocket server on port ${port}...`);

  try {
    const commandExecutor = new CommandExecutor();
    const uiInterceptor = new UIInterceptor();
    const stateReader = new StateReader();
    const outputMonitor = new OutputMonitor();
    const authHandler = new AuthHandler();

    server = new WSServer(port, {
      commandExecutor,
      uiInterceptor,
      stateReader,
      outputMonitor,
      authHandler,
    });

    await server.start();
    log.appendLine(`[activate] WebSocket server started on port ${port}`);

    context.subscriptions.push(
      { dispose: () => server?.stop() },
      ...uiInterceptor.register(),
      ...outputMonitor.register(),
      ...authHandler.register(),
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.appendLine(`[activate] ERROR: ${msg}`);
  }
}

export function deactivate(): void {
  server?.stop();
}
