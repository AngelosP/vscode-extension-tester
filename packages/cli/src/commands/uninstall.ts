import { CONTROLLER_EXTENSION_ID } from '../types.js';
import { execVSCodeCliSync, formatVSCodeCliMissingMessage, resolveVSCodeCli } from '../utils/vscode-cli.js';

/**
 * Uninstall the controller extension from VS Code.
 */
export async function uninstallCommand(): Promise<void> {
  console.log('Uninstalling controller extension from VS Code...');

  const codeCli = resolveVSCodeCli();
  if (!codeCli) {
    console.error('\nFailed to uninstall controller extension.');
    console.error(formatVSCodeCliMissingMessage());
    process.exit(1);
  }

  try {
    execVSCodeCliSync(codeCli, ['--uninstall-extension', CONTROLLER_EXTENSION_ID], {
      stdio: 'inherit',
    });
    console.log('\nController extension removed.');
  } catch {
    console.error('\nFailed to uninstall controller extension.');
    console.error('It may not be installed, or VS Code may have rejected the uninstall command.');
    process.exit(1);
  }
}
