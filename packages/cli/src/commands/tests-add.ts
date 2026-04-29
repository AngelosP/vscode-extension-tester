import * as fs from 'node:fs';
import * as path from 'node:path';
import { ControllerClient } from '../runner/controller-client.js';
import { CDP_PORT, CONTROLLER_WS_PORT, DEFAULT_FEATURES_DIR } from '../types.js';
import { loadEnv, getAgentConfig, getUserDataSummary } from '../agent/env.js';
import { loadMemories, appendMemory } from '../agent/memory.js';
import { runAgentLoop } from '../agent/agent-loop.js';
import { TOOL_DEFINITIONS, type ToolContext } from '../agent/tools.js';

// ─── Types ──────────────────────────────────────────────────────────────────────

interface TestsAddOptions {
  since?: string;
  explore?: boolean;
  run?: boolean;
  maxIterations?: string;
  model?: string;
  port?: string;
  cdpPort?: string;
}

interface ResumeMarker {
  featureFiles: string[];
  iteration: number;
  maxIterations: number;
  timestamp: number;
  failures?: Array<{ scenario: string; step: string; error: string }>;
  userContext?: string;
}

// ─── Paths ──────────────────────────────────────────────────────────────────────

const RESUME_DIR = path.join('tests', 'vscode-extension-tester');
const RESUME_FILE = '.agent-resume.json';

// ─── System Prompts ─────────────────────────────────────────────────────────────

const ADD_SYSTEM_PROMPT = `You are an expert VS Code extension test engineer. Your job is to write high-quality Gherkin .feature tests for a VS Code extension.

AVAILABLE STEP DEFINITIONS (use ONLY these exact patterns):

When steps (actions):
  When I execute command "<commandId>"
  When I start command "<commandId>"
  When I inspect the QuickInput
  When I select QuickInput item "<label>"
  When I select "<label>" from the QuickInput
  When I select "<label>" from the QuickPick
  When I select "<label>" from the popup menu
  When I enter "<value>" in the QuickInput
  When I type "<value>" into the InputBox
  When I click "<action>" on notification "<text>"
  When I type "<text>"
  When I press "<key>"
  When I click "<button>" on the dialog
  When I click the element "<accessible name>"
  When I right click the element "<accessible name>"
  When I middle click the element "<accessible name>"
  When I double click the element "<accessible name>"
  When I click "<css selector>" in the webview
  When I right click "<css selector>" in the webview
  When I middle click "<css selector>" in the webview
  When I double click "<css selector>" in the webview
  When I move the mouse to <x>, <y>
  When I click
  When I right click
  When I middle click
  When I double click
  When I click at <x>, <y>
  When I right click at <x>, <y>
  When I middle click at <x>, <y>
  When I double click at <x>, <y>

Then steps (assertions):
  Then I should see notification "<text>"
  Then I should not see notification "<text>"
  Then I wait for QuickInput item "<label>"
  Then I wait for QuickInput title "<text>"
  Then I wait for QuickInput value "<value>"
  Then the QuickInput should contain item "<label>"
  Then the QuickInput title should contain "<text>"
  Then the QuickInput value should be "<value>"
  Then I wait for progress "<title>" to start
  Then I wait for progress "<title>" to complete
  Then progress "<title>" should be active
  Then progress "<title>" should be completed
  Then the editor should contain "<text>"
  Then the output channel "<name>" should contain "<text>"
  Then the webview should contain "<text>"
  Then element "<css selector>" should exist
  Then I wait <N> seconds

INPUT TARGETING RULES:
- Prefer VS Code commands, QuickInput inspection/selection/text steps, dialog responders, and stable webview CSS selectors/data-testid values.
- Prefer QuickInput/progress/notification wait steps over fixed waits; QuickInput steps can use captured state or the visible workbench widget.
- Use accessible-name clicks for native/workbench UI when a stable name exists.
- Use right-click steps to open context menus before selecting from the popup menu.
- Use raw mouse coordinates only as a last resort when no command, selector, or accessible name can target the UI.

Variables from .env can be used as \${VARIABLE_NAME} in step text.

DATA SAFETY RULES:
- NEVER generate test steps that delete, remove, or destroy pre-existing data
- To test destructive operations, FIRST create test data in a @setup scenario
- Then test the destructive operation in a @test scenario, targeting ONLY the data you created
- Tag scenarios: @setup for data creation, @test for testing, @cleanup for removing test data
- @cleanup scenarios should ONLY remove data created by @setup scenarios
- Use unique identifiers (timestamps, UUIDs) in test data names to avoid collisions
- If the user provides data values in .env, those are for CONNECTING to existing systems, not for data to delete

YOUR WORKFLOW:
1. Use git_diff and git_log to understand what changed (unless the user gave specific context)
2. Read source files to understand command implementations and expected behavior
3. Read existing .feature files to understand current test coverage
4. Read memory files for knowledge from previous sessions
5. If you have Dev Host access, explore commands to observe real behavior
6. Draft new .feature files or updates to existing ones
7. Write the .feature files using write_feature_file
8. If you have Dev Host access, run the tests using run_test to verify they pass
9. Update memory files with what you learned
10. Call done with a summary

FILE NAMING:
- Write new feature files to tests/vscode-extension-tester/e2e/<descriptive-name>.feature
- Use descriptive names based on the functionality being tested
- Do not overwrite existing feature files unless updating them

QUALITY STANDARDS:
- Each scenario should test one specific behavior
- Include meaningful assertions (not just "I wait 2 seconds")
- Handle QuickPick and InputBox interactions when commands show them
- Test both happy paths and edge cases where reasonable
- Keep scenarios independent - no state dependencies between scenarios`;

const RESUME_SYSTEM_PROMPT = `You are an expert VS Code extension test engineer fixing failing tests.

You have access to the same tools as before. The tests you wrote in a previous session are failing.

YOUR WORKFLOW:
1. Read the failing test files and understand the failures
2. Read source code to verify expected behavior
3. If you have Dev Host access, try the failing commands manually to observe actual behavior
4. Optionally escalate log level with set_log_level for more diagnostics
5. Fix the .feature files based on what you observe
6. Run the tests again with run_test to verify the fix
7. Update memory files with lessons learned
8. Call done with a summary

COMMON FIXES:
- Wrong notification text: check actual notification by running the command and calling get_notifications
- Missing QuickPick/InputBox handling: command opens a dialog you didn't account for
- Timing issues: add "I wait N seconds" steps if commands need time
- Wrong command ID: verify with list_commands`;

// ─── Command ────────────────────────────────────────────────────────────────────

export async function testsAddCommand(
  context: string[],
  opts: TestsAddOptions,
): Promise<void> {
  const cwd = process.cwd();
  const env = loadEnv(cwd);
  const agentConfig = getAgentConfig(env);
  const memories = loadMemories(cwd);
  const userData = getUserDataSummary(env);
  const port = parseInt(opts.port ?? String(CONTROLLER_WS_PORT), 10);
  const cdpPort = parseInt(opts.cdpPort ?? String(CDP_PORT), 10);
  const maxIterations = parseInt(opts.maxIterations ?? String(agentConfig.maxIterations), 10);
  const shouldExplore = opts.explore !== false;
  const shouldRun = opts.run !== false;
  const userContext = context.join(' ').trim() || null;

  // Check for resume marker
  const resumePath = path.join(cwd, RESUME_DIR, RESUME_FILE);
  if (fs.existsSync(resumePath)) {
    console.log('Found resume marker from previous run. Resuming...\n');
    await resumeFlow(cwd, resumePath, env, memories, userData, agentConfig, port, cdpPort, maxIterations, opts.model, shouldExplore);
    return;
  }

  // ─── Stage 1: Build context for the agent ─────────────────────────────────
  console.log('Preparing agent context...');

  let initialMessage = '';
  if (userContext) {
    initialMessage = `The user wants tests for the following:\n\n${userContext}\n\nUse your tools to understand the codebase and write appropriate .feature tests. You may also use git_diff to see recent changes if relevant.`;
  } else {
    initialMessage = 'Analyze the recent git changes to this VS Code extension and write .feature tests for the new or modified functionality. Use git_diff and git_log to understand what changed.';
  }

  // Add existing context
  const existingFeatures = listExistingFeatures(cwd);
  if (existingFeatures.length > 0) {
    initialMessage += `\n\nExisting test files:\n${existingFeatures.join('\n')}`;
  }
  if (memories) {
    initialMessage += `\n\n${memories}`;
  }
  if (userData !== '(none)') {
    initialMessage += `\n\nUser data from .env:\n${userData}`;
  }
  if (agentConfig.instructions) {
    initialMessage += `\n\nAdditional instructions: ${agentConfig.instructions}`;
  }

  // ─── Stage 2: Connect to Dev Host if available ────────────────────────────
  let client: ControllerClient | undefined;
  if (shouldExplore) {
    client = await tryConnect(port);
    if (client) {
      console.log('Connected to Dev Host - live exploration enabled.\n');
    } else {
      console.log('Dev Host not available - generating tests from code analysis only.');
      console.log('Start a debug session (F5) for live validation.\n');
    }
  }

  // ─── Stage 3: Run the agent ───────────────────────────────────────────────
  const toolContext: ToolContext = {
    cwd,
    controllerClient: client,
    env,
    cdpPort,
  };

  console.log('Agent is working...\n');

  const result = await runAgentLoop({
    systemPrompt: ADD_SYSTEM_PROMPT,
    initialUserMessage: initialMessage,
    tools: TOOL_DEFINITIONS,
    toolContext,
    maxIterations,
    model: opts.model ?? agentConfig.model,
    onIteration: (i, action) => {
      process.stdout.write(`  [${i}] ${action}\n`);
    },
  });

  console.log(`\n--- Agent Complete ---`);
  console.log(`Summary: ${result.summary}`);

  if (result.filesWritten.length > 0) {
    console.log(`Feature files: ${result.filesWritten.join(', ')}`);
  }

  // ─── Stage 4: Run tests if requested ──────────────────────────────────────
  if (shouldRun && result.filesWritten.length > 0 && client) {
    console.log('\nRunning generated tests...\n');

    // Write resume marker
    const marker: ResumeMarker = {
      featureFiles: result.filesWritten,
      iteration: 0,
      maxIterations: 5,
      timestamp: Date.now(),
      userContext: userContext ?? undefined,
    };
    fs.mkdirSync(path.dirname(resumePath), { recursive: true });
    fs.writeFileSync(resumePath, JSON.stringify(marker, null, 2));

    // Run tests via the agent's run_test tool results (already done in the loop)
    // The resume marker ensures we can pick up if there are failures
    console.log('Tests completed. If any failed, run `vscode-ext-test tests add` again to auto-fix.');

    // Clean up resume marker if all passed (agent would have reported)
    if (result.completed && result.summary.toLowerCase().includes('pass')) {
      fs.unlinkSync(resumePath);
      console.log('All tests passed! Resume marker cleaned up.');
    }
  }

  client?.disconnect();
}

// ─── Resume Flow ────────────────────────────────────────────────────────────────

async function resumeFlow(
  cwd: string,
  resumePath: string,
  env: Record<string, string>,
  memories: string,
  userData: string,
  agentConfig: ReturnType<typeof getAgentConfig>,
  port: number,
  cdpPort: number,
  maxIterations: number,
  modelOverride?: string,
  shouldExplore?: boolean,
): Promise<void> {
  const marker: ResumeMarker = JSON.parse(fs.readFileSync(resumePath, 'utf-8'));

  if (marker.iteration >= marker.maxIterations) {
    console.log(`Max fix iterations (${marker.maxIterations}) reached.`);
    console.log('Review the failing tests manually or delete the resume marker to start fresh:');
    console.log(`  ${resumePath}\n`);
    fs.unlinkSync(resumePath);
    return;
  }

  // Connect to Dev Host
  let client: ControllerClient | undefined;
  if (shouldExplore !== false) {
    client = await tryConnect(port);
    if (client) {
      console.log('Connected to Dev Host.\n');
    }
  }

  // Build resume context
  let initialMessage = `You are fixing failing tests from a previous run (attempt ${marker.iteration + 1}/${marker.maxIterations}).`;

  if (marker.failures && marker.failures.length > 0) {
    initialMessage += '\n\nFailing scenarios:\n';
    for (const f of marker.failures) {
      initialMessage += `- ${f.scenario}: ${f.step} - ${f.error}\n`;
    }
  }

  initialMessage += `\n\nFeature files that need fixing:\n${marker.featureFiles.join('\n')}`;

  if (marker.userContext) {
    initialMessage += `\n\nOriginal user context: ${marker.userContext}`;
  }
  if (memories) {
    initialMessage += `\n\n${memories}`;
  }
  if (userData !== '(none)') {
    initialMessage += `\n\nUser data from .env:\n${userData}`;
  }
  if (agentConfig.instructions) {
    initialMessage += `\n\nAdditional instructions: ${agentConfig.instructions}`;
  }

  const toolContext: ToolContext = {
    cwd,
    controllerClient: client,
    env,
    cdpPort,
  };

  console.log('Agent is fixing tests...\n');

  const result = await runAgentLoop({
    systemPrompt: RESUME_SYSTEM_PROMPT,
    initialUserMessage: initialMessage,
    tools: TOOL_DEFINITIONS,
    toolContext,
    maxIterations,
    model: modelOverride ?? agentConfig.model,
    onIteration: (i, action) => {
      process.stdout.write(`  [${i}] ${action}\n`);
    },
  });

  console.log(`\n--- Fix Attempt Complete ---`);
  console.log(`Summary: ${result.summary}`);

  // Update marker
  marker.iteration += 1;
  if (result.completed && result.summary.toLowerCase().includes('pass')) {
    // Tests fixed!
    fs.unlinkSync(resumePath);
    console.log('\nAll tests passing! Resume marker cleaned up.');
    appendMemory(cwd, 'test-patterns.md', `Fixed failing tests: ${result.summary}`);
  } else {
    fs.writeFileSync(resumePath, JSON.stringify(marker, null, 2));
    console.log(`\nSome tests may still be failing. Run \`vscode-ext-test tests add\` again (attempt ${marker.iteration}/${marker.maxIterations}).`);
  }

  client?.disconnect();
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function listExistingFeatures(cwd: string): string[] {
  const featuresDir = path.resolve(cwd, DEFAULT_FEATURES_DIR);
  if (!fs.existsSync(featuresDir)) return [];

  return fs.readdirSync(featuresDir)
    .filter((f) => f.endsWith('.feature'))
    .map((f) => path.join(DEFAULT_FEATURES_DIR, f));
}

async function tryConnect(port: number): Promise<ControllerClient | undefined> {
  const client = new ControllerClient(port);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await client.connect();
      return client;
    } catch {
      await delay(1000);
    }
  }
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
