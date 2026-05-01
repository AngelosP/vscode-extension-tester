import * as fs from 'node:fs';
import * as path from 'node:path';
import * as JSONC from 'jsonc-parser';
import { CONTROLLER_EXTENSION_ID } from '../types.js';
import { getVsixPath } from './install.js';
import { execVSCodeCliSync, formatVSCodeCliMissingMessage, resolveVSCodeCli } from '../utils/vscode-cli.js';

/**
 * Scaffold tests/vscode-extension-tester/e2e/ with example .feature file and merge VS Code configs.
 * Also installs the controller extension if not already present.
 */
export async function initCommand(opts: { features?: string }): Promise<void> {
  const featuresDir = opts.features ?? 'tests/vscode-extension-tester/e2e';
  const cwd = process.cwd();

  // 0. Install controller extension if not present
  ensureControllerInstalled();

  // 1. Create features directory + .feature file generated from package.json
  //    Scaffold under e2e/default/ to match the profile-aware directory convention
  const featuresPath = path.resolve(cwd, featuresDir, 'default');
  const featurePath = path.join(featuresPath, 'extension.feature');

  if (!fs.existsSync(featurePath)) {
    fs.mkdirSync(featuresPath, { recursive: true });
    const feature = generateFeatureFromPackageJson(cwd);
    fs.writeFileSync(featurePath, feature);
    console.log(`Created ${path.relative(cwd, featurePath)}`);
  } else {
    console.log(`Skipped ${path.relative(cwd, featurePath)} (already exists)`);
  }

  // 2. Merge into .vscode/launch.json
  const vscodeDir = path.join(cwd, '.vscode');
  fs.mkdirSync(vscodeDir, { recursive: true });

  mergeLaunchConfig(path.join(vscodeDir, 'launch.json'));

  // 3. Merge into .vscode/tasks.json
  mergeTasksConfig(path.join(vscodeDir, 'tasks.json'));

  // 4. Scaffold e2e-test-extension skill
  scaffoldSkill(cwd);

  // 5. Scaffold repo-knowledge.md (only if it doesn't already exist)
  scaffoldRepoKnowledge(cwd);

  // 6. Gitignore runs directory
  addToGitignore(cwd, 'tests/vscode-extension-tester/runs/');

  console.log('\nDone! You can now:');
  console.log('  1. Run tests: vscode-ext-test run --features tests/vscode-extension-tester/e2e');
  console.log('  2. Or with a test ID: vscode-ext-test run --test-id <slug>');
  console.log('  3. Or attach to a running Dev Host: vscode-ext-test run --attach-devhost\n');
}

function ensureControllerInstalled(): void {
  const vsixPath = getVsixPath();
  if (!fs.existsSync(vsixPath)) {
    console.warn('Warning: controller extension .vsix not found. Run `vscode-ext-test install-testing-extension-to-vscode` manually.');
    return;
  }

  const codeCli = resolveVSCodeCli();
  if (!codeCli) {
    console.warn('Warning: could not find VS Code CLI; skipping automatic controller extension install.');
    console.warn(formatVSCodeCliMissingMessage());
    console.warn(`Install manually: Ctrl+Shift+P -> "Extensions: Install from VSIX..." -> ${vsixPath}`);
    return;
  }

  try {
    const installed = String(execVSCodeCliSync(codeCli, ['--list-extensions'], {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }));
    if (installed.includes(CONTROLLER_EXTENSION_ID)) {
      console.log('Controller extension already installed.');
      return;
    }
  } catch {
    // Can't check - try installing anyway
  }

  console.log('Installing controller extension...');
  try {
    execVSCodeCliSync(codeCli, ['--install-extension', vsixPath, '--force'], {
      stdio: 'inherit',
      timeout: 30000,
    });
    console.log('Controller extension installed. Restart VS Code to activate it.');
  } catch {
    console.warn('Warning: could not install controller extension automatically.');
    console.warn(`Install manually: Ctrl+Shift+P -> "Extensions: Install from VSIX..." -> ${vsixPath}`);
  }
}

function mergeLaunchConfig(filePath: string): void {
  const configName = 'Debug extension with automation support';

  if (fs.existsSync(filePath)) {
    let content = fs.readFileSync(filePath, 'utf-8');
    const json = JSONC.parse(content);
    const existing: Array<Record<string, unknown>> = json.configurations ?? [];

    if (existing.some((c) => c.name === configName)) {
      console.log(`Skipped .vscode/launch.json ("${configName}" already exists)`);
      return;
    }

    // Clone an existing extensionHost config to preserve user customizations
    const source = existing.find(
      (c) => c.type === 'extensionHost' && c.request === 'launch'
    );
    const config = source
      ? { ...JSON.parse(JSON.stringify(source)), name: configName }
      : {
          name: configName,
          type: 'extensionHost',
          request: 'launch',
          args: ['--extensionDevelopmentPath=${workspaceFolder}'],
        };
    // Ensure --remote-debugging-port is present so CDP is available in the Dev Host.
    // CRITICAL: --user-data-dir must also be set, otherwise VS Code reuses the existing
    // Electron main process for the Dev Host window and chromium-level flags like
    // --remote-debugging-port are silently ignored.
    const args: string[] = config.args ?? [];
    if (!args.some((a: string) => a.includes('--remote-debugging-port'))) {
      args.push('--remote-debugging-port=9222');
    }
    if (!args.some((a: string) => a.includes('--user-data-dir'))) {
      args.push('--user-data-dir=${workspaceFolder}/.vscode-test-user-data');
    }
    if (!args.some((a: string) => a.includes('--disable-workspace-trust'))) {
      args.push('--disable-workspace-trust');
    }
    config.args = args;
    // Set env var so the controller extension starts its WS server in the Dev Host
    config.env = { ...(config.env ?? {}), VSCODE_EXT_TESTER_PORT: '9788' };

    const edits = JSONC.modify(content, ['configurations', -1], config, {
      formattingOptions: { tabSize: 2, insertSpaces: true },
    });
    content = JSONC.applyEdits(content, edits);
    fs.writeFileSync(filePath, content);

    if (source) {
      console.log(`Added "${configName}" to .vscode/launch.json (cloned from "${source.name}")`);
    } else {
      console.log(`Added "${configName}" to .vscode/launch.json`);
    }
  } else {
    const json = {
      version: '0.2.0',
      configurations: [{
        name: configName,
        type: 'extensionHost',
        request: 'launch',
        args: [
          '--extensionDevelopmentPath=${workspaceFolder}',
          '--remote-debugging-port=9222',
          '--user-data-dir=${workspaceFolder}/.vscode-test-user-data',
          '--disable-workspace-trust',
        ],
        env: { VSCODE_EXT_TESTER_PORT: '9788' },
      }],
    };
    fs.writeFileSync(filePath, JSON.stringify(json, null, 2) + '\n');
    console.log('Created .vscode/launch.json');
  }
}

function mergeTasksConfig(filePath: string): void {
  const taskLabel = 'vscode-ext-test: run';
  const newTask = {
    label: taskLabel,
    type: 'shell',
    command: 'vscode-ext-test',
    args: ['run', '--attach-devhost'],
    isBackground: true,
    presentation: { reveal: 'always', panel: 'dedicated' },
    problemMatcher: {
      pattern: { regexp: '^(FAIL|ERROR):\\s+(.*)$', message: 2 },
      background: {
        activeOnStart: true,
        beginsPattern: '^Running \\\\d+ feature',
        endsPattern: '^Found Extension Development Host',
      },
    },
  };

  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const json = JSONC.parse(content);

    // Check if task already exists
    const tasks: Array<{ label?: string }> = json.tasks ?? [];
    if (tasks.some((t) => t.label === taskLabel)) {
      console.log(`Skipped .vscode/tasks.json ("${taskLabel}" already exists)`);
      return;
    }

    // Add to existing tasks array
    const edits = JSONC.modify(content, ['tasks', -1], newTask, {
      formattingOptions: { tabSize: 2, insertSpaces: true },
    });
    const updated = JSONC.applyEdits(content, edits);
    fs.writeFileSync(filePath, updated);
    console.log(`Added "${taskLabel}" to .vscode/tasks.json`);
  } else {
    const json = {
      version: '2.0.0',
      tasks: [newTask],
    };
    fs.writeFileSync(filePath, JSON.stringify(json, null, 2) + '\n');
    console.log('Created .vscode/tasks.json');
  }
}

function generateFeatureFromPackageJson(cwd: string): string {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return fallbackFeature('Extension');
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const displayName: string = pkg.displayName ?? pkg.name ?? 'Extension';
  const contributes = pkg.contributes ?? {};
  const commands: Array<{ command: string; title: string }> = contributes.commands ?? [];
  const viewContainers: Array<{ id: string }> = contributes.viewsContainers?.activitybar ?? [];

  // List available commands as a reference for the user
  const commandList = commands.map((c) => `#   ${c.command} - ${c.title}`).join('\n');

  const lines: string[] = [
    `Feature: ${displayName} Smoke Test`,
    `  Verify the ${displayName} extension activates and is responsive`,
    '',
    `  # Available commands (add your own scenarios below):`,
  ];

  if (commandList) {
    lines.push(commandList);
  }

  lines.push('');

  // Only generate a single activation smoke test
  lines.push(
    `  Scenario: Extension activates`,
    `    # This just verifies the extension host is up and the controller responds`,
    `    Then I wait 2 seconds`,
    '',
  );

  // If there's an activity bar view, test that it's reachable (safe, no dialogs)
  if (viewContainers.length > 0) {
    lines.push(
      `  Scenario: Activity bar view opens`,
      `    When I execute command "workbench.view.extension.${viewContainers[0].id}"`,
      `    Then I wait 1 second`,
      '',
    );
  }

  return lines.join('\n');
}

function fallbackFeature(name: string): string {
  return `Feature: ${name} Smoke Test
  Verify the extension activates and is responsive

  Scenario: Extension activates
    Then I wait 2 seconds
`;
}

/**
 * Scaffold the e2e-test-extension SKILL.md into the target codebase.
 */
export function scaffoldSkill(cwd: string): void {
  const skillDir = path.join(cwd, '.github', 'skills', 'e2e-test-extension');
  const skillPath = path.join(skillDir, 'SKILL.md');

  fs.mkdirSync(skillDir, { recursive: true });

  // Read the SKILL.md template from src/skill/ in the package root
  const templatePath = path.resolve(__dirname, '..', '..', 'src', 'skill', 'SKILL.md');
  const content = fs.readFileSync(templatePath, 'utf-8');

  fs.writeFileSync(skillPath, content, 'utf-8');
  console.log(`Created ${path.relative(cwd, skillPath)}`);
}

/**
 * Scaffold the repo-knowledge.md file into the target codebase.
 * Unlike SKILL.md, this file is NEVER overwritten — it persists across inits
 * so the user/agent can accumulate repo-specific knowledge over time.
 */
export function scaffoldRepoKnowledge(cwd: string): void {
  const skillDir = path.join(cwd, '.github', 'skills', 'e2e-test-extension');
  const knowledgePath = path.join(skillDir, 'repo-knowledge.md');

  if (fs.existsSync(knowledgePath)) {
    console.log(`Skipped ${path.relative(cwd, knowledgePath)} (already exists)`);
    return;
  }

  fs.mkdirSync(skillDir, { recursive: true });

  const content = `# Repo-Specific Testing Knowledge

This file is your persistent knowledge base for E2E testing this specific
codebase with vscode-extension-tester. Unlike SKILL.md (which is overwritten
on every \`vscode-ext-test install-into-project\` to stay current with framework updates),
**this file is never overwritten** — it accumulates knowledge across sessions.

## How to Use

Read this file before every test session. Update it after every session with
anything new you learned. Structure it however makes sense for this repo.

## Extension Commands

<!-- List the command IDs this extension registers and what they do -->

## Webview Selectors

<!-- CSS selectors, data-testid values, and webview titles that work for this extension -->

## Activation & Setup Quirks

<!-- E.g. "needs a .kql file open before commands are available" -->

## Known Issues & Workarounds

<!-- Flaky areas, timing-sensitive steps, framework workarounds -->

## Testability Recommendations

<!-- data-testid attributes you recommended adding to the extension source -->
`;

  fs.writeFileSync(knowledgePath, content, 'utf-8');
  console.log(`Created ${path.relative(cwd, knowledgePath)}`);
}

/**
 * Add a line to .gitignore if it's not already present.
 */
export function addToGitignore(cwd: string, entry: string): void {
  const gitignorePath = path.join(cwd, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    if (content.includes(entry)) {
      return;
    }
    const separator = content.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(gitignorePath, `${separator}${entry}\n`, 'utf-8');
  } else {
    fs.writeFileSync(gitignorePath, `${entry}\n`, 'utf-8');
  }
  console.log(`Added '${entry}' to .gitignore`);
}
