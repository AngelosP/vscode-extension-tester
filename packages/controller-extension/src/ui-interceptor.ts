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
  private pendingDialog?: {
    resolve: (button: string) => void;
    reject: (err: Error) => void;
  };

  /** Resolve callback for an intercepted showInputBox() call. */
  private pendingInputBoxResolve?: (value: string | undefined) => void;

  // Store intercepted QuickPick/InputBox items for state queries
  private lastQuickPickItems: string[] = [];
  private lastInputBoxPrompt: string = '';

  register(): vscode.Disposable[] {
    // Monkey-patch showInputBox to intercept calls from the extension under
    // test. The VS Code 'type' command targets Monaco editor instances and
    // does NOT reach the native <input> element used by showInputBox(). By
    // intercepting the call we can resolve it programmatically — same pattern
    // used for dialog interception.
    const self = this;
    const originalShowInputBox = vscode.window.showInputBox;

    vscode.window.showInputBox = function (
      options?: vscode.InputBoxOptions,
      token?: vscode.CancellationToken,
    ): Thenable<string | undefined> {
      self.lastInputBoxPrompt = options?.prompt ?? options?.placeHolder ?? '';

      return new Promise<string | undefined>((resolve) => {
        self.pendingInputBoxResolve = resolve;

        // Show the real InputBox UI so screen recordings look natural.
        // We ignore its return value — respondToInputBox() resolves our
        // promise instead. If the user manually interacts (or presses
        // Escape), the original's .then() fires and resolves ours.
        originalShowInputBox.call(vscode.window, options, token).then(
          (userResult) => {
            if (self.pendingInputBoxResolve === resolve) {
              self.pendingInputBoxResolve = undefined;
              resolve(userResult);
            }
          },
          () => {
            if (self.pendingInputBoxResolve === resolve) {
              self.pendingInputBoxResolve = undefined;
              resolve(undefined);
            }
          },
        );
      });
    };

    return [
      { dispose() { vscode.window.showInputBox = originalShowInputBox; } },
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
   *
   * If showInputBox() was intercepted (monkey-patch installed via register()),
   * resolves the pending promise directly — bypassing the native <input> that
   * the 'type' command can't reach. Returns `intercepted: false` when the
   * monkey-patch didn't fire (e.g. the extension cached the original
   * showInputBox reference) so the caller can fall back to CDP.
   */
  async respondToInputBox(value: string): Promise<{ entered: string; intercepted: boolean }> {
    if (this.pendingInputBoxResolve) {
      const resolve = this.pendingInputBoxResolve;
      this.pendingInputBoxResolve = undefined;

      // Resolve the extension's `await showInputBox()` with the value
      resolve(value);

      // Dismiss the visual InputBox widget
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');

      return { entered: value, intercepted: true };
    }

    // Monkey-patch didn't fire — the extension may have cached the original
    // showInputBox reference before our patch was installed, or this is a
    // QuickPick filter (not showInputBox). Signal the caller to use CDP.
    return { entered: value, intercepted: false };
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
