import * as path from 'node:path';
import * as cp from 'node:child_process';
import { CONTROLLER_EXTENSION_ID } from '../types.js';

/**
 * Install the controller extension and verify prerequisites.
 */
export async function installCommand(): Promise<void> {
  // 1. Check prerequisites
  checkPrerequisites();

  // 2. Install controller extension
  const vsixPath = getVsixPath();
  const codeCmd = process.platform === 'win32' ? 'code.cmd' : 'code';

  console.log('\nInstalling controller extension into VS Code...');

  try {
    cp.execSync(`${codeCmd} --install-extension "${vsixPath}" --force`, {
      stdio: 'inherit',
    });
    console.log('\nController extension installed successfully.');
    console.log('Restart VS Code if it is currently open.');
  } catch {
    console.error('\nFailed to install controller extension.');
    console.error('You can install manually in VS Code:');
    console.error(`  Ctrl+Shift+P → "Extensions: Install from VSIX..." → ${vsixPath}`);
    process.exit(1);
  }
}

function checkPrerequisites(): void {
  console.log('Checking prerequisites...\n');
  let allGood = true;

  // Check GitHub CLI
  const hasGh = commandExists('gh');
  if (hasGh) {
    console.log('  \u2713 GitHub CLI (gh) installed');

    // Check if authenticated
    try {
      cp.execSync('gh auth token', { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
      console.log('  \u2713 GitHub CLI authenticated');
    } catch {
      console.log('  \u2717 GitHub CLI not authenticated');
      console.log('    Run: gh auth login');
      allGood = false;
    }
  } else {
    console.log('  \u2717 GitHub CLI (gh) not found');
    console.log('    Install from: https://cli.github.com');
    console.log('    Required for AI-powered test generation (tests add)');
    allGood = false;
  }

  // Check VS Code CLI
  const codeCmd = process.platform === 'win32' ? 'code.cmd' : 'code';
  if (commandExists(codeCmd)) {
    console.log(`  \u2713 VS Code CLI (${codeCmd}) available`);
  } else {
    console.log(`  \u2717 VS Code CLI (${codeCmd}) not found`);
    console.log('    In VS Code: Ctrl+Shift+P → "Shell Command: Install \'code\' command in PATH"');
    allGood = false;
  }

  // Check Git
  if (commandExists('git')) {
    console.log('  \u2713 Git installed');
  } else {
    console.log('  \u2717 Git not found');
    console.log('    Required for tests add (git diff analysis)');
    allGood = false;
  }

  if (!allGood) {
    console.log('\nSome prerequisites are missing. Core features will work but AI features require all prerequisites.');
  }
}

function commandExists(cmd: string): boolean {
  try {
    cp.execSync(process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the path to the bundled controller extension .vsix file.
 */
export function getVsixPath(): string {
  // The .vsix is bundled in the assets/ directory relative to this package
  return path.resolve(__dirname, '..', '..', 'assets', 'controller-extension.vsix');
}
