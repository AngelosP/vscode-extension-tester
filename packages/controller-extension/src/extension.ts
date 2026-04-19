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

// Patch output-channel creation as soon as this module is loaded in the Dev Host.
// This narrows the activation race and also captures the controller's own channel.
const outputMonitor = envPort ? new OutputMonitor() : undefined;
const outputMonitorDisposables = outputMonitor ? outputMonitor.register() : [];
const log = vscode.window.createOutputChannel('Extension Tester Controller');

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  registerDebugConfigProvider(context);

  if (!envPort) {
    log.appendLine('[activate] VSCODE_EXT_TESTER_PORT not set - standby mode');
    return;
  }

  context.subscriptions.push(...outputMonitorDisposables);

  const port = parseInt(envPort, 10);
  log.appendLine(`[activate] Starting WebSocket server on port ${port}...`);

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
    log.appendLine(`[activate] WebSocket server started on port ${port}`);

    context.subscriptions.push(
      { dispose: () => server?.stop() },
      ...uiInterceptor.register(),
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
