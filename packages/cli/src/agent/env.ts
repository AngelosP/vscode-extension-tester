import * as fs from 'node:fs';
import * as path from 'node:path';

const ENV_DIR = path.join('tests', 'vscode-extension-tester');
const ENV_FILE = '.env';

export interface AgentConfig {
  model?: string;
  maxIterations: number;
  logLevel: string;
  instructions?: string;
}

/**
 * Load the .env file from tests/vscode-extension-tester/.env
 * Returns all key-value pairs as a flat record.
 */
export function loadEnv(cwd: string): Record<string, string> {
  const envPath = path.join(cwd, ENV_DIR, ENV_FILE);
  if (!fs.existsSync(envPath)) return {};

  const content = fs.readFileSync(envPath, 'utf-8');
  return parseEnvFile(content);
}

/**
 * Extract agent-specific config from loaded env values.
 */
export function getAgentConfig(env: Record<string, string>): AgentConfig {
  return {
    model: env['MODEL'] || undefined,
    maxIterations: parseInt(env['MAX_AGENT_ITERATIONS'] ?? '20', 10),
    logLevel: env['LOG_LEVEL'] ?? 'info',
    instructions: env['AGENT_INSTRUCTIONS'] || undefined,
  };
}

/**
 * Get user data values (everything that isn't agent config).
 * Password/secret values are masked for display in prompts.
 */
export function getUserDataSummary(env: Record<string, string>): string {
  const agentKeys = new Set(['MODEL', 'MAX_AGENT_ITERATIONS', 'LOG_LEVEL', 'AGENT_INSTRUCTIONS']);
  const sensitivePattern = /password|secret|token|key|credential/i;

  const entries = Object.entries(env)
    .filter(([key]) => !agentKeys.has(key))
    .map(([key, value]) => {
      const masked = sensitivePattern.test(key) ? '***' : value;
      return `${key}=${masked}`;
    });

  return entries.length > 0 ? entries.join('\n') : '(none)';
}

// ─── Parser ─────────────────────────────────────────────────────────────────────

function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();

    // Skip empty lines and comments
    if (!line || line.startsWith('#')) continue;

    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Handle escape sequences in double-quoted values
    if (rawLine.slice(rawLine.indexOf('=') + 1).trim().startsWith('"')) {
      value = value.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
    }

    if (key) {
      result[key] = value;
    }
  }

  return result;
}
