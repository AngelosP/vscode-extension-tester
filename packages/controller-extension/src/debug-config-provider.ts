import * as vscode from 'vscode';

const CDP_PORT = 9222;
const DEFAULT_USER_DATA_DIR = '${workspaceFolder}/.vscode-test-user-data';

/**
 * Registers a DebugConfigurationProvider for the 'extensionHost' debug type.
 * When the user presses F5 to debug their extension, resolveDebugConfiguration()
 * fires and auto-injects --remote-debugging-port so we get CDP access for free.
 *
 * This is the zero-config magic: the user doesn't need to edit launch.json.
 */
export class DebugConfigProvider implements vscode.DebugConfigurationProvider {
  resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    _token?: vscode.CancellationToken
  ): vscode.DebugConfiguration | undefined {
    // Only modify extensionHost configs
    if (config.type !== 'extensionHost') {
      return config;
    }

    // Ensure args array exists
    if (!config.args) {
      config.args = [];
    }

    // Inject --remote-debugging-port if not already present
    const hasDebugPort = (config.args as string[]).some(
      (arg: string) => arg.includes('--remote-debugging-port')
    );
    if (!hasDebugPort) {
      (config.args as string[]).push(`--remote-debugging-port=${CDP_PORT}`);
    }

    const hasUserDataDir = (config.args as string[]).some(
      (arg: string) => arg.includes('--user-data-dir')
    );
    if (!hasUserDataDir) {
      (config.args as string[]).push(`--user-data-dir=${DEFAULT_USER_DATA_DIR}`);
    }

    const hasWorkspaceTrustFlag = (config.args as string[]).some(
      (arg: string) => arg.includes('--disable-workspace-trust')
    );
    if (!hasWorkspaceTrustFlag) {
      (config.args as string[]).push('--disable-workspace-trust');
    }

    // Set env var so the controller extension in the Dev Host knows the port
    if (!config.env) {
      config.env = {};
    }
    const port = vscode.workspace
      .getConfiguration('extensionTester')
      .get<number>('controllerPort', 9788);
    config.env['VSCODE_EXT_TESTER_PORT'] = String(port);

    return config;
  }
}

/**
 * Register the debug config provider. Call this from activate().
 */
export function registerDebugConfigProvider(
  context: vscode.ExtensionContext
): void {
  const provider = new DebugConfigProvider();
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(
      'extensionHost',
      provider
    )
  );
}
