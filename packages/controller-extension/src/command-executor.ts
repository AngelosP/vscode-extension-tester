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
    if (commandId === 'workbench.action.closeAllEditors') {
      return this.closeAllEditors({ discardDirty: false });
    }
    const result = await vscode.commands.executeCommand(
      commandId,
      ...(args ?? [])
    );
    return result ?? { executed: true };
  }

  async closeAllEditors(options: { discardDirty: boolean }): Promise<{ closed: true; discarded: string[] }> {
    const dirtyBeforeClose = getDirtyTabs();
    if (!options.discardDirty && dirtyBeforeClose.length > 0) {
      throw new Error(`Dirty editors prevent closeAllEditors: ${dirtyBeforeClose.map(({ tab }) => tab.label).join(', ')}`);
    }

    const discarded = options.discardDirty ? await this.discardDirtyEditors() : [];
    let closeError: Error | undefined;
    try {
      await withTimeout(
        Promise.resolve(vscode.commands.executeCommand('workbench.action.closeAllEditors')),
        5_000,
        'Closing all editors timed out after 5000ms',
      );
    } catch (error) {
      if (!options.discardDirty) throw error;
      closeError = error instanceof Error ? error : new Error(String(error));
      discarded.push(...await this.discardDirtyEditors());
      await withTimeout(
        Promise.resolve(vscode.commands.executeCommand('workbench.action.closeAllEditors')),
        5_000,
        'Closing all editors still timed out after discarding dirty editors',
      );
    }

    const uniqueDiscarded = [...new Set(discarded)];
    if (closeError && uniqueDiscarded.length === 0) throw closeError;
    return { closed: true, discarded: uniqueDiscarded };
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

  private async discardDirtyEditors(): Promise<string[]> {
    const dirtyTabs = getDirtyTabs();
    const discarded: string[] = [];
    for (const { group, tab } of dirtyTabs) {
      await activateTab(group, tab);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      discarded.push(tab.label);
    }
    const survivors = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.isDirty);
    if (survivors.length > 0) {
      throw new Error(`Unable to discard dirty editors: ${survivors.map((tab) => tab.label).join(', ')}`);
    }
    return discarded;
  }
}

async function activateTab(group: vscode.TabGroup, tab: vscode.Tab): Promise<void> {
  const input = tab.input;
  if (input instanceof vscode.TabInputCustom) {
    await vscode.commands.executeCommand('vscode.openWith', input.uri, input.viewType, {
      viewColumn: group.viewColumn,
      preview: false,
      preserveFocus: false,
    });
  } else {
    const focusCommands = [
      'workbench.action.focusFirstEditorGroup',
      'workbench.action.focusSecondEditorGroup',
      'workbench.action.focusThirdEditorGroup',
      'workbench.action.focusFourthEditorGroup',
      'workbench.action.focusFifthEditorGroup',
      'workbench.action.focusSixthEditorGroup',
      'workbench.action.focusSeventhEditorGroup',
      'workbench.action.focusEighthEditorGroup',
    ];
    const focusCommand = group.isActive
      ? 'workbench.action.focusActiveEditorGroup'
      : focusCommands[(group.viewColumn ?? 1) - 1] ?? 'workbench.action.focusLastEditorGroup';
    await vscode.commands.executeCommand(focusCommand);
    const index = group.tabs.indexOf(tab);
    if (index >= 0) await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', index + 1);
  }

  await waitForTabActivation(group, tab);
}

async function waitForTabActivation(group: vscode.TabGroup, tab: vscode.Tab): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const currentGroup = vscode.window.tabGroups.all.find((candidate) => candidate.viewColumn === group.viewColumn);
    const currentTab = currentGroup?.tabs.find((candidate) => sameTab(candidate, tab));
    if (currentGroup?.isActive && currentTab?.isActive) return;
    await delay(25);
  }
  throw new Error(`Unable to activate dirty editor before discard: ${tab.label}`);
}

function sameTab(candidate: vscode.Tab, expected: vscode.Tab): boolean {
  if (candidate === expected) return true;
  if (candidate.label !== expected.label) return false;
  if (candidate.input instanceof vscode.TabInputCustom && expected.input instanceof vscode.TabInputCustom) {
    return candidate.input.viewType === expected.input.viewType && candidate.input.uri.toString() === expected.input.uri.toString();
  }
  return candidate.input === expected.input;
}

function getDirtyTabs(): Array<{ group: vscode.TabGroup; tab: vscode.Tab }> {
  return vscode.window.tabGroups.all.flatMap((group) =>
    group.tabs.filter((tab) => tab.isDirty).map((tab) => ({ group, tab })),
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
