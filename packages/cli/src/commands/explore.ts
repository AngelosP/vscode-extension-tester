import { ControllerClient } from '../runner/controller-client.js';
import { CONTROLLER_WS_PORT } from '../types.js';
import { loadEnv, getAgentConfig } from '../agent/env.js';
import { loadMemories } from '../agent/memory.js';
import { runAgentLoop } from '../agent/agent-loop.js';
import { TOOL_DEFINITIONS, type ToolContext } from '../agent/tools.js';

interface ExploreOptions {
  port?: string;
  model?: string;
}

const EXPLORE_SYSTEM_PROMPT = `You are an expert VS Code extension tester exploring an extension to understand how it works.

Your goal is to thoroughly explore the extension's functionality by:
1. Listing available commands to understand what the extension offers
2. Reading source files to understand command implementations
3. Executing commands in the live Dev Host to observe real behavior
4. Noting what notifications appear, what UI elements are shown, what dialogs open
5. Documenting your findings in memory files for future test generation

EXPLORATION STRATEGY:
- Start by reading package.json to understand the extension's structure
- List all commands registered by this extension
- Read key source files (extension.ts, command handlers) to understand implementations
- Try executing safe, non-destructive commands and observe the results
- Check the state after each command (notifications, editor content, output channels)
- Document UI flows: "command X opens QuickPick with options [A, B, C], selecting A does Y"
- Note any commands that require prerequisites (open file, active connection, etc.)

SAFETY RULES:
- Do NOT execute commands that delete, remove, or destroy data
- Do NOT execute commands that modify external systems without explicit user instruction
- If a command opens a file picker or system dialog, note it but don't get stuck on it
- If something goes wrong, note the error and move on

When you have explored enough, write your findings to memory files:
- extension-analysis.md: Overall extension architecture, key features, command behaviors
- ui-flows.md: Discovered UI flows, QuickPick sequences, dialog chains
- test-patterns.md: Insights on what can be tested and how

Then call the done tool with a summary.`;

export async function exploreCommand(opts: ExploreOptions): Promise<void> {
  const cwd = process.cwd();
  const port = parseInt(opts.port ?? String(CONTROLLER_WS_PORT), 10);
  const env = loadEnv(cwd);
  const agentConfig = getAgentConfig(env);
  const memories = loadMemories(cwd);

  // Connect to Dev Host
  console.log(`Connecting to Dev Host on port ${port}...`);
  const client = new ControllerClient(port);

  let connected = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await client.connect();
      connected = true;
      break;
    } catch {
      if (attempt < 9) await delay(1000);
    }
  }

  if (!connected) {
    console.error('Could not connect to the Extension Development Host.');
    console.error('Start a debug session (F5) first, then run this command.');
    process.exit(1);
  }

  console.log('Connected. Starting exploration agent...\n');

  const toolContext: ToolContext = {
    cwd,
    controllerClient: client,
    env,
  };

  let initialMessage = 'Explore this VS Code extension. Discover its commands, UI flows, and behaviors. Write your findings to memory files.';
  if (memories) {
    initialMessage += `\n\n${memories}`;
  }
  if (agentConfig.instructions) {
    initialMessage += `\n\nADDITIONAL INSTRUCTIONS: ${agentConfig.instructions}`;
  }

  try {
    const result = await runAgentLoop({
      systemPrompt: EXPLORE_SYSTEM_PROMPT,
      initialUserMessage: initialMessage,
      tools: TOOL_DEFINITIONS,
      toolContext,
      maxIterations: agentConfig.maxIterations,
      model: opts.model ?? agentConfig.model,
      onIteration: (i, action) => {
        process.stdout.write(`  [${i}] ${action}\n`);
      },
    });

    console.log(`\n--- Exploration Complete ---`);
    console.log(`Iterations: ${result.iterations}`);
    console.log(`Summary: ${result.summary}`);
    if (result.filesWritten.length > 0) {
      console.log(`Files written: ${result.filesWritten.join(', ')}`);
    }
  } finally {
    client.disconnect();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
