import * as vscode from 'vscode';

/**
 * Intercepts VS Code UI prompts (QuickPick, InputBox, message dialogs)
 * and allows them to be answered programmatically via WebSocket commands,
 * while still showing the UI so screen recordings look natural.
 */
export class UIInterceptor {
  private pendingQuickPick?: {
    resolve: (label: string) => void;
    reject: (err: Error) => void;
  };
  private pendingInputBox?: {
    resolve: (value: string) => void;
    reject: (err: Error) => void;
  };
  private pendingDialog?: {
    resolve: (button: string) => void;
    reject: (err: Error) => void;
  };

  // Store intercepted QuickPick/InputBox items for state queries
  private lastQuickPickItems: string[] = [];
  private lastInputBoxPrompt: string = '';

  register(): vscode.Disposable[] {
    return [
      // Monitor when QuickPick/InputBox becomes visible via document change events
      // The actual interception happens via the respondTo* methods which trigger
      // VS Code commands to select items in the active UI
    ];
  }

  /**
   * Select an item from the currently active QuickPick by label.
   * Uses workbench commands to interact with the real UI.
   */
  async respondToQuickPick(label: string): Promise<{ selected: string }> {
    // Type the label text to filter the QuickPick, then accept
    await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');

    // Use the Type command to filter to the desired item
    await vscode.commands.executeCommand('type', { text: label });

    // Small delay to let the filter apply
    await delay(200);

    // Accept the currently highlighted item
    await vscode.commands.executeCommand(
      'workbench.action.acceptSelectedQuickOpenItem'
    );

    return { selected: label };
  }

  /**
   * Type a value into the currently active InputBox and accept it.
   */
  async respondToInputBox(value: string): Promise<{ entered: string }> {
    // Type the value into the active input
    await vscode.commands.executeCommand('type', { text: value });
    await delay(100);

    // Accept the input
    await vscode.commands.executeCommand(
      'workbench.action.acceptSelectedQuickOpenItem'
    );

    return { entered: value };
  }

  /**
   * Click a button on a VS Code message dialog (info/warning/error).
   * The dialog is intercepted via the pending promise pattern.
   */
  async respondToDialog(button: string): Promise<{ clicked: string }> {
    if (this.pendingDialog) {
      this.pendingDialog.resolve(button);
      this.pendingDialog = undefined;
      return { clicked: button };
    }
    throw new Error('No dialog is currently pending');
  }

  /**
   * Create a proxy for showing message dialogs that can be controlled remotely.
   * Call this to wrap vscode.window.showInformationMessage etc.
   */
  createDialogPromise(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.pendingDialog = { resolve, reject };
    });
  }

  getLastQuickPickItems(): string[] {
    return this.lastQuickPickItems;
  }

  getLastInputBoxPrompt(): string {
    return this.lastInputBoxPrompt;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
