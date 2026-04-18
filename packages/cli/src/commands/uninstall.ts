import * as cp from 'node:child_process';
import { CONTROLLER_EXTENSION_ID } from '../types.js';

/**
 * Uninstall the controller extension from VS Code.
 */
export async function uninstallCommand(): Promise<void> {
  console.log('Uninstalling controller extension from VS Code...');

  try {
    cp.execSync(`${process.platform === 'win32' ? 'code.cmd' : 'code'} --uninstall-extension ${CONTROLLER_EXTENSION_ID}`, {
      stdio: 'inherit',
    });
    console.log('\nController extension removed.');
  } catch {
    console.error('\nFailed to uninstall controller extension.');
    console.error('It may not be installed, or `code` is not in PATH.');
    process.exit(1);
  }
}
