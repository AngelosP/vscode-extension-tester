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
   * Get all available command IDs.
   */
  async listCommands(): Promise<string[]> {
    return vscode.commands.getCommands(true);
  }
}
