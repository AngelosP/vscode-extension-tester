import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_FEATURES_DIR } from '../types.js';
import { complete, probeModels, getGitHubToken } from '../agent/llm.js';
import { loadEnv, getAgentConfig, getUserDataSummary } from '../agent/env.js';
import { loadMemories } from '../agent/memory.js';

interface GenerateOptions {
  features?: string;
  output?: string;
  model?: string;
}

/**
 * Generate intelligent .feature files by analyzing the extension codebase
 * and using GitHub Copilot (via gh CLI) to produce contextual test scenarios.
 */
export async function generateCommand(opts: GenerateOptions): Promise<void> {
  const cwd = process.cwd();
  const featuresDir = path.resolve(cwd, opts.features ?? DEFAULT_FEATURES_DIR);
  const outputFile = opts.output ?? 'generated.feature';
  const outputPath = path.join(featuresDir, outputFile);

  // 1. Gather extension context
  console.log('Analyzing extension...');
  const context = gatherExtensionContext(cwd);

  if (!context.packageJson) {
    console.error('Error: No package.json found. Run this from a VS Code extension project root.');
    process.exit(1);
  }

  console.log(`  Extension: ${context.displayName}`);
  console.log(`  Commands: ${context.commands.length}`);
  console.log(`  Views: ${context.views.length}`);
  console.log(`  Source files analyzed: ${context.sourceSnippets.length}`);

  // 2. Load environment and memories
  const env = loadEnv(cwd);
  const agentConfig = getAgentConfig(env);
  const memories = loadMemories(cwd);
  const userData = getUserDataSummary(env);

  // 3. Verify GitHub auth and probe for best model
  const token = getGitHubToken();
  if (!token) {
    console.error('\nError: GitHub Copilot authentication required.');
    console.error('Install the GitHub CLI and authenticate:');
    console.error('  1. Install: https://cli.github.com');
    console.error('  2. Login:   gh auth login');
    console.error('  3. Retry:   vscode-ext-test generate\n');
    process.exit(1);
  }

  const model = opts.model ?? agentConfig.model;
  const selectedModel = await probeModels(token, model);
  console.log(`\nUsing model: ${selectedModel}`);
  console.log('Generating tests...\n');

  // 4. Build prompt and call LLM
  const prompt = buildPrompt(context, memories, userData, agentConfig.instructions);
  const feature = await complete(
    'You are a test generation assistant. You output only valid Gherkin .feature file content. No markdown, no explanations, no code fences.',
    prompt,
    { model: selectedModel },
  );

  if (!feature) {
    console.error('Error: Failed to generate tests. Check your Copilot subscription.');
    process.exit(1);
  }

  // 5. Write output (strip any markdown fences)
  const cleaned = feature.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim() + '\n';
  fs.mkdirSync(featuresDir, { recursive: true });
  fs.writeFileSync(outputPath, cleaned, 'utf-8');
  console.log(`Generated: ${path.relative(cwd, outputPath)}`);
  console.log(`\nReview the generated tests, then run:`);
  console.log(`  vscode-ext-test run\n`);
}

// ─── Context Gathering ─────────────────────────────────────────────────────────

interface ExtensionContext {
  packageJson: Record<string, unknown> | null;
  displayName: string;
  commands: Array<{ command: string; title: string; category?: string }>;
  views: Array<{ id: string; name: string; container?: string }>;
  viewContainers: Array<{ id: string; title: string }>;
  activationEvents: string[];
  configurationProperties: Array<{ key: string; type: string; description: string }>;
  menus: Record<string, Array<{ command: string; when?: string }>>;
  sourceSnippets: Array<{ file: string; content: string }>;
  readmeExcerpt: string;
}

function gatherExtensionContext(cwd: string): ExtensionContext {
  const ctx: ExtensionContext = {
    packageJson: null,
    displayName: 'Extension',
    commands: [],
    views: [],
    viewContainers: [],
    activationEvents: [],
    configurationProperties: [],
    menus: {},
    sourceSnippets: [],
    readmeExcerpt: '',
  };

  // Read package.json
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) return ctx;

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  ctx.packageJson = pkg;
  ctx.displayName = pkg.displayName ?? pkg.name ?? 'Extension';

  const contributes = pkg.contributes ?? {};

  // Commands
  ctx.commands = (contributes.commands ?? []).map((c: Record<string, string>) => ({
    command: c.command,
    title: c.title,
    category: c.category,
  }));

  // Views
  const views = contributes.views ?? {};
  for (const [container, viewList] of Object.entries(views)) {
    for (const v of viewList as Array<{ id: string; name: string }>) {
      ctx.views.push({ id: v.id, name: v.name, container });
    }
  }

  // View containers
  const containers = contributes.viewsContainers?.activitybar ?? [];
  ctx.viewContainers = containers.map((c: Record<string, string>) => ({
    id: c.id,
    title: c.title,
  }));

  // Activation events
  ctx.activationEvents = pkg.activationEvents ?? [];

  // Configuration
  const config = contributes.configuration;
  if (config) {
    const props = config.properties ?? (Array.isArray(config) ? config[0]?.properties : {}) ?? {};
    for (const [key, def] of Object.entries(props)) {
      const d = def as Record<string, string>;
      ctx.configurationProperties.push({
        key,
        type: d.type ?? 'unknown',
        description: d.description ?? '',
      });
    }
  }

  // Menus (command palette enablement, etc.)
  ctx.menus = contributes.menus ?? {};

  // Read activation source files to understand command implementations
  ctx.sourceSnippets = gatherSourceSnippets(cwd, ctx.commands.map((c) => c.command));

  // README excerpt (first 2000 chars)
  const readmePath = findFile(cwd, ['README.md', 'readme.md', 'Readme.md']);
  if (readmePath) {
    const content = fs.readFileSync(readmePath, 'utf-8');
    ctx.readmeExcerpt = content.slice(0, 2000);
  }

  return ctx;
}

function gatherSourceSnippets(
  cwd: string,
  commandIds: string[],
): Array<{ file: string; content: string }> {
  const snippets: Array<{ file: string; content: string }> = [];
  const srcDir = path.join(cwd, 'src');
  if (!fs.existsSync(srcDir)) return snippets;

  // Find files that reference command registrations or implementations
  const tsFiles = findFilesRecursive(srcDir, /\.(ts|js)$/, 20);

  for (const filePath of tsFiles) {
    const content = fs.readFileSync(filePath, 'utf-8');

    // Include files that register commands, contribute to activation, or contain test-relevant logic
    const isRelevant = commandIds.some((id) => content.includes(id)) ||
      /registerCommand|registerTextEditorCommand|activat|onCommand/.test(content);

    if (isRelevant) {
      // Truncate large files to the relevant parts
      const truncated = content.length > 3000 ? content.slice(0, 3000) + '\n// ... (truncated)' : content;
      snippets.push({ file: path.relative(cwd, filePath), content: truncated });
    }
  }

  return snippets;
}

function findFilesRecursive(dir: string, pattern: RegExp, maxFiles: number): string[] {
  const results: string[] = [];
  const walk = (d: string) => {
    if (results.length >= maxFiles) return;
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== 'out') {
        walk(fullPath);
      } else if (entry.isFile() && pattern.test(entry.name)) {
        results.push(fullPath);
      }
    }
  };
  walk(dir);
  return results;
}

function findFile(dir: string, names: string[]): string | null {
  for (const name of names) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ─── Prompt Building ────────────────────────────────────────────────────────────

function buildPrompt(ctx: ExtensionContext, memories: string, userData: string, instructions?: string): string {
  const stepDefs = `
AVAILABLE STEP DEFINITIONS (you MUST only use these exact patterns):

When steps (actions):
  When I execute command "<commandId>"
  When I start command "<commandId>"
  When I select "<label>" from the QuickPick
  When I select "<label>" from the popup menu
  When I type "<value>" into the InputBox
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
  Then the editor should contain "<text>"
  Then the output channel "<name>" should contain "<text>"
  Then the webview should contain "<text>"
  Then element "<css selector>" should exist
  Then I wait <N> seconds

RULES:
- ONLY use the step patterns listed above. Do not invent new ones.
- NEVER test commands that open file pickers, folder pickers, or system dialogs (they hang waiting for user input).
- NEVER test destructive commands (delete, remove, clear, reset, drop, purge, uninstall, disconnect, sign out).
- NEVER test commands that require authentication or network connections unless handling auth explicitly.
- Only test commands that are self-contained and can complete without user interaction beyond QuickPick/InputBox.
- Each scenario should be independent - do not depend on state from a previous scenario.
- Use "I wait N seconds" sparingly, only when the command needs time to complete.
- Keep scenarios focused - test one behavior per scenario.
- Include at least one assertion per scenario (notification, editor content, or output channel).
- If a command opens a QuickPick or InputBox, handle it with the appropriate step.
- Prefer commands and stable webview selectors/data-testid values; use accessible-name clicks next; use raw coordinates only as a last resort.
- Use right-click steps to open context menus before selecting items from popup menus.
`;

  const commandList = ctx.commands.map((c) => {
    const cat = c.category ? `[${c.category}] ` : '';
    return `  - ${c.command}: ${cat}${c.title}`;
  }).join('\n');

  const viewList = ctx.views.map((v) => `  - ${v.id}: ${v.name} (in ${v.container})`).join('\n');
  const containerList = ctx.viewContainers.map((c) => `  - ${c.id}: ${c.title}`).join('\n');

  const menuInfo = Object.entries(ctx.menus)
    .filter(([key]) => key === 'commandPalette')
    .map(([key, items]) => {
      const menuItems = (items as Array<{ command: string; when?: string }>)
        .map((i) => `    ${i.command}${i.when ? ` (when: ${i.when})` : ''}`)
        .join('\n');
      return `  ${key}:\n${menuItems}`;
    }).join('\n');

  const sourceContext = ctx.sourceSnippets.map((s) =>
    `--- ${s.file} ---\n${s.content}`
  ).join('\n\n');

  const base = `You are a VS Code extension test generator. Generate a Gherkin .feature file that tests the "${ctx.displayName}" extension.

${stepDefs}

EXTENSION INFO:
  Name: ${ctx.displayName}
  Activation: ${ctx.activationEvents.length > 0 ? ctx.activationEvents.join(', ') : '*'}

COMMANDS:
${commandList || '  (none)'}

VIEWS:
${viewList || '  (none)'}

VIEW CONTAINERS:
${containerList || '  (none)'}

COMMAND PALETTE VISIBILITY:
${menuInfo || '  (no restrictions)'}

${ctx.readmeExcerpt ? `README EXCERPT:\n${ctx.readmeExcerpt}\n` : ''}
${sourceContext ? `SOURCE CODE (command implementations):\n${sourceContext}\n` : ''}
Based on the above, generate a comprehensive .feature file. Analyze the source code to understand:
1. Which commands can run without file/folder pickers or external dependencies
2. What QuickPick options or InputBox prompts each command shows
3. What notifications, editor content, or output channel messages to expect

Output ONLY the .feature file content, nothing else. No markdown fences.`;

  // Append memories, user data, and instructions if available
  let extra = '';
  if (memories) extra += `\n\n${memories}`;
  if (userData !== '(none)') extra += `\n\nUSER DATA FROM .env:\n${userData}`;
  if (instructions) extra += `\n\nADDITIONAL INSTRUCTIONS FROM USER:\n${instructions}`;

  return base + extra;
}

// ─── Exported for reuse by agent ────────────────────────────────────────────────

export { gatherExtensionContext, type ExtensionContext };
