import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command, type CommandOptions } from 'commander';
import { runCommand } from './commands/run.js';
import { liveCommand } from './commands/live.js';
import { installCommand } from './commands/install.js';
import { updateCommand } from './commands/update.js';
import { uninstallCommand } from './commands/uninstall.js';
import { initCommand } from './commands/init.js';
import { testsAddCommand } from './commands/tests-add.js';
import { openProfile, deleteProfile, listProfiles } from './profile.js';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('vscode-ext-test')
    .description('E2E test VS Code extensions as if a real user was operating them')
    .version(readCliPackageVersion());

  program
  .command('run')
  .description('Run E2E tests against a VS Code extension')
  .option('--attach-devhost', 'Attach to an already-running Dev Host instead of launching one', false)
  .option('--extension-path <dir>', 'Path to extension project', '.')
  .option('--features <dir>', 'Root profile-aware e2e directory', 'tests/vscode-extension-tester/e2e')
  .option('--test-id <slug>', 'Test slug - selects features from e2e/<profile>/<slug>/, writes artifacts to runs/<profile>/<slug>/')
  .option('--vscode-version <version>', 'VS Code version to download for isolated launch', 'stable')
  .option('--record', 'Enable screen recording', false)
  .option('--record-on-failure', 'Record only if tests fail', false)
  .option('--reporter <type>', 'Output format: console, json, html', 'console')
  .option('--controller-port <number>', 'Controller WebSocket port', '9788')
  .option('--cdp-port <number>', 'Chrome DevTools Protocol port', '9222')
  .option('--xvfb', 'Use xvfb for headless Linux', false)
  .option('--timeout <ms>', 'Per-step timeout in ms', '30000')
  .option('--reuse-named-profile <name>', 'Use an existing named profile (fails if missing)')
  .option('--reuse-or-create-named-profile <name>', 'Use a named profile, creating it if missing')
  .option('--clone-named-profile <name>', 'Clone a named profile into an ephemeral worker, delete after run')
  .option('--auto-reset', 'Force a clean-start reset before every scenario', false)
  .option('--no-build', 'Skip building the extension before running tests')
  .option('--paused', 'Set up the environment but pause before running tests', false)
  .option('--parallel', 'Opt into parallel execution of reset-boundary groups', false)
  .option('--max-workers <n>', 'Max parallel workers (requires --parallel)')
  .action(runCommand);

  program
  .command('live')
  .description('Start or attach to VS Code and execute Gherkin steps over JSONL stdin/stdout')
  .option('--mode <mode>', 'Session mode: auto, launch, attach', 'auto')
  .option('--extension-path <dir>', 'Path to extension project', '.')
  .option('--features <dir>', 'Root profile-aware e2e directory', 'tests/vscode-extension-tester/e2e')
  .option('--vscode-version <version>', 'VS Code version to download for isolated launch', 'stable')
  .option('--controller-port <number>', 'Controller WebSocket port', '9788')
  .option('--cdp-port <number>', 'Chrome DevTools Protocol port', '9222')
  .option('--timeout <ms>', 'Per-step timeout in ms', '30000')
  .option('--reuse-named-profile <name>', 'Use an existing named profile (fails if missing)')
  .option('--reuse-or-create-named-profile <name>', 'Use a named profile, creating it if missing')
  .option('--clone-named-profile <name>', 'Clone a named profile into an ephemeral worker, delete after run')
  .option('--xvfb', 'Use xvfb for headless Linux', false)
  .option('--no-build', 'Skip building the extension before starting')
  .option('--screenshot-policy <policy>', 'Screenshot policy: always, onFailure, never', 'always')
  .option('--no-final-screenshot', 'Skip final screenshot before shutdown')
  .option('--artifacts-dir <dir>', 'Directory for live artifacts')
  .action(liveCommand);

  program
  .command('install-testing-extension-to-vscode')
  .description('Install the testing controller extension into VS Code')
  .action(installCommand);

  program
  .command('install-testing-extension-to-profiles')
  .description('Install the testing controller extension into VS Code and all named profiles')
  .action(updateCommand);

  program
  .command('uninstall')
  .description('Remove the controller extension from VS Code')
  .action(uninstallCommand);

  program
  .command('install-into-project')
  .description('Scaffold tests/vscode-extension-tester/e2e/ with example .feature file and VS Code configs')
  .option('--features <dir>', 'Target directory for .feature files', 'tests/vscode-extension-tester/e2e')
  .action(initCommand);

  addDeprecatedAlias(program, 'install', 'install-testing-extension-to-vscode', installCommand);
  addDeprecatedAlias(program, 'update', 'install-testing-extension-to-profiles', updateCommand);
  addDeprecatedAlias(program, 'init', 'install-into-project', initCommand, (command) => {
    command.option('--features <dir>', 'Target directory for .feature files', 'tests/vscode-extension-tester/e2e');
  });

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
  .option('--cdp-port <number>', 'Chrome DevTools Protocol port', '9222')
  .option('--live-mode <mode>', 'Live exploration mode: auto, launch, attach, off', 'auto')
  .action(testsAddCommand);

// ─── Profile management ──────────────────────────────────────────────────────

  const profileCmd = program
  .command('profile')
  .description('Manage named test profiles');

  profileCmd
  .command('open <name>')
  .description('Open a named profile in VS Code so you can authenticate or prepare prerequisites')
  .option('--extension-path <dir>', 'Path to extension project to load in the profile', '.')
  .action((name: string, opts: { extensionPath?: string }) => {
    try {
      openProfile(name, opts.extensionPath);
    } catch (err: unknown) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

  profileCmd
  .command('delete <name>')
  .description('Delete a named profile and all its data')
  .action((name: string) => {
    try {
      deleteProfile(name);
    } catch (err: unknown) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

  profileCmd
  .command('list')
  .description('List all named profiles')
  .action(() => {
    const profiles = listProfiles();
    if (profiles.length === 0) {
      console.log('No named profiles found.');
    } else {
      console.log('Named profiles:');
      for (const p of profiles) {
        console.log(`  - ${p}`);
      }
    }
  });

  return program;
}

export function main(argv = process.argv): void {
  createProgram().parse(argv);
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  main();
}

function addDeprecatedAlias(
  program: Command,
  oldCommand: string,
  newCommand: string,
  action: (...args: any[]) => void | Promise<void>,
  configure?: (command: Command) => void,
): void {
  const command = program
    .command(oldCommand, { hidden: true } satisfies CommandOptions)
    .description(`Deprecated alias for ${newCommand}`);
  configure?.(command);
  command.action((...args: any[]) => {
    console.warn(`Warning: \`vscode-ext-test ${oldCommand}\` is deprecated. Use \`vscode-ext-test ${newCommand}\`.`);
    return action(...args);
  });
}

function readCliPackageVersion(): string {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8')) as { version?: string };
    return packageJson.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
