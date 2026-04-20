import * as vscode from 'vscode';

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

  /**
   * Get all available command IDs.
   */
  async listCommands(): Promise<string[]> {
    return vscode.commands.getCommands(true);
  }
}
