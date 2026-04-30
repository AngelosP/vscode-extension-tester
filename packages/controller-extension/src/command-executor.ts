import * as vscode from 'vscode';

export interface ExtensionHostScriptResult {
  ok: boolean;
  value?: unknown;
  error?: { name?: string; message: string; stack?: string };
  durationMs: number;
}

export class CommandExecutor {
  /**
   * Execute a VS Code command by ID with optional arguments.
   */
  async execute(commandId: string, args?: unknown[]): Promise<unknown> {
    const result = await vscode.commands.executeCommand(
      commandId,
      ...(args ?? [])
    );
    return result ?? { executed: true };
  }

  /**
   * Start a VS Code command without waiting for it to complete.
   * Use for commands that show InputBox/QuickPick dialogs to avoid deadlocking.
   */
  start(commandId: string, args?: unknown[]): { started: true; commandId: string } {
    vscode.commands.executeCommand(commandId, ...(args ?? [])).then(
      undefined,
      (err) => console.error('[vscode-ext-test] Fire-and-forget command failed:', commandId, err),
    );
    return { started: true, commandId };
  }

  async runExtensionHostScript(script: string, timeoutMs = 30_000): Promise<ExtensionHostScriptResult> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`Invalid script timeout: ${timeoutMs}`);
    }

    const started = Date.now();
    try {
      const fn = new Function('vscode', `return (async () => {\n${script}\n})()`);
      const value = await withTimeout(
        Promise.resolve(fn(vscode)),
        timeoutMs,
        `Extension-host script timed out after ${timeoutMs}ms`,
      );
      return { ok: true, value: toJsonSafe(value), durationMs: Date.now() - started };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return {
        ok: false,
        error: { name: error.name, message: error.message, stack: error.stack },
        durationMs: Date.now() - started,
      };
    }
  }

  /**
   * Get all available command IDs.
   */
  async listCommands(): Promise<string[]> {
    return vscode.commands.getCommands(true);
  }
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  });
}

function toJsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') return value;
  if (valueType === 'bigint') return String(value);
  if (valueType === 'function' || valueType === 'symbol') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => toJsonSafe(item, seen));
  if (valueType === 'object') {
    const objectValue = value as Record<string, unknown>;
    if (seen.has(objectValue)) return '[Circular]';
    seen.add(objectValue);
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(objectValue)) {
      result[key] = toJsonSafe(child, seen);
    }
    seen.delete(objectValue);
    return result;
  }
  return String(value);
}
