import * as cp from 'node:child_process';

// ─── Model Cascade ──────────────────────────────────────────────────────────────

/** Models to try in order of preference. User can override via .env MODEL= */
export const MODEL_CASCADE = [
  'anthropic/claude-sonnet-4',
  'openai/gpt-4.1',
  'openai/gpt-4o',
  'openai/o4-mini',
];

const API_BASE = 'https://models.github.ai/inference/chat/completions';

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LLMResponse {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface LLMOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

// ─── Token Management ───────────────────────────────────────────────────────────

let cachedToken: string | null = null;

export function getGitHubToken(): string | null {
  if (cachedToken) return cachedToken;

  // Try gh CLI first
  try {
    const token = cp.execSync('gh auth token', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (token) {
      cachedToken = token;
      return token;
    }
  } catch { /* fall through */ }

  // Try environment variables
  const envToken = process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'];
  if (envToken) {
    cachedToken = envToken;
    return envToken;
  }

  return null;
}

// ─── Model Probing ──────────────────────────────────────────────────────────────

let cachedModel: string | null = null;

/**
 * Probe the GitHub Models API to find the best available model.
 * Tries each model in the cascade with a minimal request.
 */
export async function probeModels(token: string, override?: string): Promise<string> {
  if (override) {
    // User explicitly chose a model - validate it supports function calling
    const works = await testModel(token, override);
    if (works) return override;
    throw new Error(
      `Model "${override}" is not available or does not support function calling.\n` +
      `Available models: ${MODEL_CASCADE.join(', ')}`
    );
  }

  if (cachedModel) return cachedModel;

  for (const model of MODEL_CASCADE) {
    const works = await testModel(token, model);
    if (works) {
      cachedModel = model;
      return model;
    }
  }

  throw new Error(
    'No supported model available. Tried: ' + MODEL_CASCADE.join(', ') + '\n' +
    'Make sure your GitHub Copilot subscription is active.'
  );
}

async function testModel(token: string, model: string): Promise<boolean> {
  try {
    const response = await fetch(API_BASE, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Say "ok"' }],
        max_tokens: 5,
        tools: [{
          type: 'function',
          function: {
            name: 'test',
            description: 'test function',
            parameters: { type: 'object', properties: {} },
          },
        }],
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ─── LLM Call ───────────────────────────────────────────────────────────────────

/**
 * Call the LLM via GitHub Models API with function calling support.
 */
export async function callLLM(
  messages: LLMMessage[],
  tools?: ToolDefinition[],
  options?: LLMOptions,
): Promise<LLMResponse> {
  const token = getGitHubToken();
  if (!token) {
    throw new Error(
      'GitHub authentication required.\n' +
      '  1. Install GitHub CLI: https://cli.github.com\n' +
      '  2. Run: gh auth login\n'
    );
  }

  const model = options?.model ?? cachedModel ?? await probeModels(token);

  const body: Record<string, unknown> = {
    model,
    messages: messages.map(formatMessage),
    temperature: options?.temperature ?? 0.3,
  };

  if (options?.maxTokens) {
    body['max_tokens'] = options.maxTokens;
  }

  if (tools && tools.length > 0) {
    body['tools'] = tools;
    body['tool_choice'] = 'auto';
  }

  const response = await fetch(API_BASE, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Authentication failed (${response.status}). Run: gh auth login`);
    }
    if (response.status === 429) {
      throw new Error('Rate limited. Wait a moment and try again.');
    }
    throw new Error(`GitHub Models API error (${response.status}): ${text}`);
  }

  const data = await response.json() as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: ToolCall[];
      };
      finish_reason?: string;
    }>;
    model?: string;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };

  const choice = data.choices?.[0];
  if (!choice?.message) {
    throw new Error('No response from model');
  }

  return {
    content: choice.message.content ?? null,
    toolCalls: choice.message.tool_calls ?? [],
    finishReason: choice.finish_reason ?? 'stop',
    model: data.model ?? model,
    usage: data.usage,
  };
}

/**
 * Simple one-shot completion (no function calling). For backwards compatibility.
 */
export async function complete(
  systemPrompt: string,
  userPrompt: string,
  options?: LLMOptions,
): Promise<string | null> {
  const response = await callLLM(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    undefined,
    options,
  );
  return response.content;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function formatMessage(msg: LLMMessage): Record<string, unknown> {
  const formatted: Record<string, unknown> = { role: msg.role };

  if (msg.content !== undefined) formatted['content'] = msg.content;
  if (msg.tool_calls) formatted['tool_calls'] = msg.tool_calls;
  if (msg.tool_call_id) formatted['tool_call_id'] = msg.tool_call_id;

  return formatted;
}
