import { callLLM, probeModels, getGitHubToken } from './llm.js';
import type { LLMMessage, ToolDefinition, ToolCall } from './llm.js';
import { executeToolCall, type ToolContext } from './tools.js';

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface AgentLoopOptions {
  systemPrompt: string;
  initialUserMessage: string;
  tools: ToolDefinition[];
  toolContext: ToolContext;
  maxIterations: number;
  model?: string;
  onIteration?: (iteration: number, action: string) => void;
}

export interface AgentResult {
  iterations: number;
  summary: string;
  filesWritten: string[];
  completed: boolean;
}

// ─── Agent Loop ─────────────────────────────────────────────────────────────────

/**
 * Run the autonomous agent loop. 
 * The agent observes, thinks (via LLM with function calling), and acts
 * until it calls the `done` tool or exhausts its iteration budget.
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentResult> {
  const {
    systemPrompt,
    initialUserMessage,
    tools,
    toolContext,
    maxIterations,
    model: modelOverride,
    onIteration,
  } = options;

  // Resolve model
  const token = getGitHubToken();
  if (!token) {
    throw new Error('GitHub authentication required. Run: gh auth login');
  }
  const model = await probeModels(token, modelOverride);
  console.log(`Agent using model: ${model}`);

  // Initialize conversation
  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: initialUserMessage },
  ];

  let summary = '';
  const filesWritten: string[] = [];
  let completed = false;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    onIteration?.(iteration, 'thinking');

    // Call LLM
    const response = await callLLM(messages, tools, { model });

    // If no tool calls, the agent is just responding with text
    if (response.toolCalls.length === 0) {
      messages.push({ role: 'assistant', content: response.content });

      // If the model stopped naturally, it's done
      if (response.finishReason === 'stop') {
        summary = response.content ?? 'Agent completed without explicit summary.';
        completed = true;
        break;
      }
      continue;
    }

    // Push the assistant message with tool calls
    messages.push({
      role: 'assistant',
      content: response.content,
      tool_calls: response.toolCalls,
    });

    // Execute each tool call
    for (const toolCall of response.toolCalls) {
      const toolName = toolCall.function.name;
      onIteration?.(iteration, `${toolName}`);

      // Check for done
      if (toolName === 'done') {
        try {
          const args = JSON.parse(toolCall.function.arguments);
          summary = args.summary ?? 'Done.';
        } catch {
          summary = 'Done.';
        }
        completed = true;

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: `Task completed: ${summary}`,
        });
        break;
      }

      // Track file writes
      if (toolName === 'write_feature_file') {
        try {
          const args = JSON.parse(toolCall.function.arguments);
          if (args.path) filesWritten.push(args.path);
        } catch { /* ignore */ }
      }

      // Execute the tool
      const result = await executeToolCall(toolName, toolCall.function.arguments, toolContext);

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result,
      });
    }

    if (completed) break;

    // Usage info for monitoring
    if (response.usage) {
      const { prompt_tokens, completion_tokens } = response.usage;
      process.stderr.write(`  [iteration ${iteration}/${maxIterations}, tokens: ${prompt_tokens}+${completion_tokens}]\n`);
    }
  }

  if (!completed) {
    summary = `Agent stopped after ${maxIterations} iterations without completing. Partial work may have been saved.`;
  }

  return { iterations: messages.filter((m) => m.role === 'assistant').length, summary, filesWritten, completed };
}
