import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cp from 'node:child_process';
import * as JSONC from 'jsonc-parser';

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
  const featuresPath = path.resolve(cwd, featuresDir);
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

  // 5. Gitignore runs directory
  addToGitignore(cwd, 'tests/vscode-extension-tester/runs/');

  console.log('\nDone! You can now:');
  console.log('  1. Select "Debug extension with automation support" from the debug dropdown and press F5');
  console.log('  2. Then run `vscode-ext-test run --run-id <slug>`\n');
}

function ensureControllerInstalled(): void {
  const codeCmd = process.platform === 'win32' ? 'code.cmd' : 'code';
  try {
    const installed = cp.execSync(`${codeCmd} --list-extensions`, {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (installed.includes('vscode-extension-tester-controller')) {
      console.log('Controller extension already installed.');
      return;
    }
  } catch {
    // Can't check — try installing anyway
  }

  const vsixPath = path.resolve(__dirname, '..', '..', 'assets', 'controller-extension.vsix');
  if (!fs.existsSync(vsixPath)) {
    console.warn('Warning: controller extension .vsix not found. Run `vscode-ext-test install` manually.');
    return;
  }

  console.log('Installing controller extension...');
  try {
    cp.execSync(`${codeCmd} --install-extension "${vsixPath}" --force`, {
      stdio: 'inherit',
      timeout: 30000,
    });
    console.log('Controller extension installed. Restart VS Code to activate it.');
  } catch {
    console.warn('Warning: could not install controller extension automatically.');
    console.warn(`Install manually: Ctrl+Shift+P → "Extensions: Install from VSIX..." → ${vsixPath}`);
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
        args: ['--extensionDevelopmentPath=${workspaceFolder}'],
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
    args: ['run', '--wait-for-devhost'],
    isBackground: true,
    presentation: { reveal: 'always', panel: 'dedicated' },
    problemMatcher: {
      pattern: { regexp: '^(FAIL|ERROR):\\s+(.*)$', message: 2 },
      background: {
        activeOnStart: true,
        beginsPattern: '^Running \\\\d+ feature',
        endsPattern: '^Waiting for Extension Development Host',
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

  if (fs.existsSync(skillPath)) {
    console.log(`Skipped ${path.relative(cwd, skillPath)} (already exists)`);
    return;
  }

  fs.mkdirSync(skillDir, { recursive: true });

  const content = `---
name: e2e-test-extension
description: >
  E2E test and verify VS Code extension behavior using vscode-extension-tester.
  Write Gherkin .feature files, run them against a fresh Extension Development Host
  with full capabilities (CDP, input automation, DOM interaction), and review
  structured test results and artifacts.
applyTo: "tests/vscode-extension-tester/**"
---

# e2e-test-extension

Use this skill to create, run, and verify E2E tests for a VS Code extension.
Every run launches a fresh Dev Host with unique ports — all steps are always available.

## Your Role

You are a pessimistic, aggressive E2E tester. Your job is to find bugs.
You get promoted and rewarded for catching real bugs. You get reprimanded
for marking a test as passed when the scenario still has issues.

**Rules:**
- Never take shortcuts. Always test the real, full thing end-to-end.
- Never assume something works — verify it with assertions.
- If a scenario passes too easily, be suspicious. Add more assertions.
- Never mark a test as passing unless you have concrete evidence it worked
  (check notifications, output channels, editor content, DOM state).
- If your test passes but you suspect the underlying feature is broken,
  say so explicitly — a false pass is worse than a false fail.
- **A test that only checks "no errors thrown" is NOT a passing test.**
  You MUST verify the expected outcome actually happened.

## Screenshot Verification

Steps passing without errors does NOT mean the test passed. After every test
run, you MUST verify the screenshots.

Screenshots are saved as \`.png\` files in the run directory. The \`report.md\`
lists all screenshot file paths.

**To verify screenshots**, use the \`view_image\` tool with the absolute path
to each \`.png\` file. This shows you the actual screenshot so you can see
what the Dev Host looked like at that point in the test.

Example:
\\\`\\\`\\\`
view_image("C:/Users/.../tests/vscode-extension-tester/runs/<run-id>/1-screenshot.png")
\\\`\\\`\\\`

After viewing each screenshot:
1. Verify the expected UI state is visible
2. Check for error dialogs or unexpected states
3. If a screenshot shows something wrong, the test FAILED — even if all
   steps reported "passed"
4. Report what you see in each screenshot

**Do NOT skip screenshot verification. Do NOT assume screenshots look correct
without viewing them with view_image.**

## When to Stop and Request Framework Improvements

If the testing framework is missing functionality you need to write a proper
test, **do not write a weak test as a workaround**. Instead:

1. Stop writing the test.
2. Clearly describe what capability is missing (e.g. "I need a step that
   reads the text content of a specific DOM element in the webview" or
   "I need a step that waits until a CSS selector appears").
3. File this as a request for a testing framework improvement.
4. Do NOT substitute a worse test that skips the critical verification —
   a test that doesn't verify the right thing is worse than no test.

## Debug Session Lifecycle

Before running tests, ensure the Dev Host has the latest code.
Use the \`run_vscode_command\` tool for these:

- **Restart** (if already running): \`workbench.action.debug.restart\` — restarts
  the Dev Host with fresh code. This is faster than stop+start.
- **Start** (if not running): \`workbench.action.debug.start\` — launches the Dev Host (F5).
  The correct config is already selected. Do NOT use \`selectandstart\`.
- **Stop**: \`workbench.action.debug.stop\` — closes the Dev Host (Shift+F5).

### Test Workflow

1. \`run_vscode_command\` → \`workbench.action.debug.restart\` (restart existing session
   with latest code; if no session is running, use \`workbench.action.debug.start\` instead)
2. Run: \`vscode-ext-test run --run-id <id>\` (polls up to 60s for Dev Host)
3. Review results
4. Leave the debug session running for the next test run

## Workflow

1. **Write .feature files** in \`tests/vscode-extension-tester/e2e/<run-id>/\`:
   \`\`\`
   mkdir -p tests/vscode-extension-tester/e2e/<run-id>
   \`\`\`
   \`\`\`gherkin
   Feature: Verify CSV export
     Scenario: Export results to CSV
       When I execute command "kusto.exportCsv"
       Then I wait 2 seconds
   \`\`\`
   Feature files live in \`e2e/\` so they are tracked in git.

2. **Run the tests**:
   \`\`\`bash
   vscode-ext-test run --run-id <run-id>
   \`\`\`
   This connects to the running Dev Host, executes all .feature files from
   \`e2e/<run-id>/\`, and writes artifacts to \`runs/<run-id>/\`.

3. **Review artifacts** — artifacts are in \`tests/vscode-extension-tester/runs/<run-id>/\` (gitignored):
   - \`report.md\` — read this FIRST. It lists all results AND screenshot file paths.
   - \`results.json\` — structured results with screenshot paths.
   - \`console.log\` — structured output log per scenario/step.
   - \`*.png\` — screenshot images.

4. **Verify screenshots** — use \`view_image\` on each .png listed in \`report.md\`. Do NOT skip this step.

## Tips

- The Dev Host is already running. Do NOT try to launch it yourself.
- Run IDs are disposable \u2014 create a new one for each investigation.
- The \`runs/\` directory is gitignored; artifacts are ephemeral.

## Available Gherkin Steps

- \`Given the extension is in a clean state\` — reset: close all editors, dismiss notifications, clear output channels
- \`When I execute command "<command-id>"\` — run any VS Code command
- \`When I select "<label>" from the QuickPick\` — pick an item from an open QuickPick
- \`When I type "<text>" into the InputBox\` — type into a VS Code InputBox prompt
- \`When I click "<button>" on the dialog\` — click a button on a modal dialog
- \`When I type "<text>"\` — type text into whatever is focused (editors, webview Monaco, inputs)
- \`When I press "<key>"\` — press a key or combo (Enter, Escape, Ctrl+S, Ctrl+Space, Shift+Tab, F5, etc.)
- \`When I sign in with Microsoft as "<user>"\` — handle Microsoft auth flow
- \`Then I should see notification "<text>"\` — assert a notification contains text
- \`Then I should not see notification "<text>"\` — assert NO notification contains text
- \`Then the editor should contain "<text>"\` — assert the active editor has text
- \`Then the output channel "<name>" should contain "<text>"\` — assert output channel content
- \`Then the output channel "<name>" should not contain "<text>"\` — assert output channel does NOT contain text
- \`Then I wait <n> second(s)\` — pause for n seconds

### Click/Focus Elements in Webviews (Windows UI Automation)
These use Windows accessibility to find and click elements by their name or text.
They work for ANY element — including inside webviews, custom editors, and dialogs:
- \`When I click the element "<name>"\` — click an element by its accessible name/text
- \`When I click the "<name>" button\` — click a button by name
- \`When I click the "<name>" edit\` — click a text field by name

Example — click a button inside a webview:
\\\`\\\`\\\`gherkin
When I click the element "Select favorite..."
When I click the element "Run Query"
When I click the "File name:" edit
\\\`\\\`\\\`

### Native OS Dialogs (Windows)
- \`When I save the file as "<path>"\` — handle Save As dialog: type filename, click Save
- \`When I open the file "<path>"\` — handle Open File dialog: type filename, click Open
- \`When I click "<button>" on the "<title>" dialog\` — click a button on any native dialog
- \`When I cancel the Save As dialog\` — dismiss a Save/Open dialog

### Screenshots
- \`Then I take a screenshot\` — capture the full screen, saved to the run directory
- \`Then I take a screenshot "label"\` — capture with a descriptive label (e.g. "after-query-runs")

### File Utilities (direct via code — no UI dialogs)
Use these for test setup when you don't need to test the actual dialog interaction:
- \`Given a file "<path>" exists\` — create an empty file (relative to cwd or absolute)
- \`Given a file "<path>" exists with content "<text>"\` — create a file with content
- \`Given a temp file "<name>" exists\` — create in OS temp directory
- \`Given a temp file "<name>" exists with content "<text>"\` — create temp file with content
- \`When I open file "<path>" in the editor\` — open file directly (no Open dialog)
- \`When I delete file "<path>"\` — delete a file
- \`Then the file "<path>" should exist\` — assert file exists on disk
- \`Then the file "<path>" should contain "<text>"\` — assert file content

### Clean State

Every test should start from a known state. Use Background to reset before each scenario:

\\\`\\\`\\\`gherkin
Feature: My tests
  Background:
    Given the extension is in a clean state
    And I wait 1 second

  Scenario: First test
    When I execute command "myExtension.doSomething"
    ...
\\\`\\\`\\\`

The reset step closes all editors, dismisses notifications, clears output channels,
and closes panels/sidebars. This ensures each scenario starts from the same baseline.

## Tips

- Run IDs are disposable — create a new one for each investigation.
- The \`runs/\` directory is gitignored; artifacts are ephemeral.
- Each \`--run-id\` run launches a fresh VS Code instance.
  All steps always work — no prerequisites, no extra flags needed.
- The Dev Host is automatically closed when the run finishes.

## Focus & Input

The framework uses two layers to control focus and input:

1. **VS Code commands** — navigate to panels, editors, views:
   \`\`\`gherkin
   When I execute command "workbench.action.focusActiveEditorGroup"
   When I execute command "workbench.view.extension.myPanel"
   \`\`\`

2. **Type and press** — send keystrokes to whatever is currently focused:
   \`\`\`gherkin
   When I type "StormEvents | take 10"
   When I press "Ctrl+Enter"
   \`\`\`

### Example: type into a webview Monaco editor

\`\`\`gherkin
Scenario: Run a Kusto query
  When I execute command "workbench.action.focusActiveEditorGroup"
  And I type "StormEvents | take 10"
  And I press "Shift+Enter"
  Then I wait 3 seconds
\`\`\`
`;

  fs.writeFileSync(skillPath, content, 'utf-8');
  console.log(`Created ${path.relative(cwd, skillPath)}`);
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
