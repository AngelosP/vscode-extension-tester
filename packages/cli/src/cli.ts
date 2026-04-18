import { Command } from 'commander';
import { runCommand } from './commands/run.js';
import { installCommand } from './commands/install.js';
import { uninstallCommand } from './commands/uninstall.js';
import { initCommand } from './commands/init.js';
import { testsAddCommand } from './commands/tests-add.js';

const program = new Command();

program
  .name('vscode-ext-test')
  .description('E2E test VS Code extensions as if a real user was operating them')
  .version('0.1.0');

program
  .command('run')
  .description('Run E2E tests against a VS Code extension')
  .option('--ci', 'Force CI mode (launch new VS Code instance)', false)
  .option('--wait-for-devhost', 'Poll until Extension Development Host appears', false)
  .option('--extension-path <dir>', 'Path to extension project', '.')
  .option('--features <dir>', 'Path to .feature files', 'tests/vscode-extension-tester/e2e')
  .option('--vscode-version <version>', 'VS Code version for CI mode', 'stable')
  .option('--record', 'Enable screen recording', false)
  .option('--record-on-failure', 'Record only if tests fail', false)
  .option('--reporter <type>', 'Output format: console, json, html', 'console')
  .option('--port <number>', 'Controller WebSocket port', '9788')
  .option('--xvfb', 'Use xvfb for headless Linux', false)
  .option('--timeout <ms>', 'Per-step timeout in ms', '30000')
  .option('--run-id <slug>', 'Run ID — reads features from runs/<slug>/, writes artifacts there')
  .action(runCommand);

program
  .command('install')
  .description('Install the controller extension into VS Code')
  .action(installCommand);

program
  .command('uninstall')
  .description('Remove the controller extension from VS Code')
  .action(uninstallCommand);

program
  .command('init')
  .description('Scaffold tests/vscode-extension-tester/e2e/ with example .feature file and VS Code configs')
  .option('--features <dir>', 'Target directory for .feature files', 'tests/vscode-extension-tester/e2e')
  .action(initCommand);

const testsCmd = program
  .command('tests')
  .description('AI-powered test management');

testsCmd
  .command('add')
  .description('Automatically generate tests from git changes or user description')
  .argument('[context...]', 'Optional description of what to test')
  .option('--since <ref>', 'Git ref to diff against (default: auto-detect)')
  .option('--no-explore', 'Skip live Dev Host exploration')
  .option('--no-run', 'Draft tests without running them')
  .option('--max-iterations <n>', 'Max agent iterations', '20')
  .option('--model <name>', 'LLM model to use')
  .option('--port <number>', 'Controller WebSocket port', '9788')
  .action(testsAddCommand);

program.parse();
