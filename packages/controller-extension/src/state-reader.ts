import * as vscode from 'vscode';

// Inline types to avoid dependency on @vscode-extension-tester/core at bundle time
interface VSCodeState {
  activeEditor?: EditorState;
  visibleEditors: EditorState[];
  terminals: TerminalState[];
  notifications: NotificationInfo[];
  sidebarVisible: boolean;
  panelVisible: boolean;
  activeViewId?: string;
}

interface EditorState {
  fileName: string;
  languageId: string;
  content: string;
  selections: Array<{
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
  }>;
  isDirty: boolean;
}

interface TerminalState {
  name: string;
  processId?: number;
  isActive: boolean;
}

interface NotificationInfo {
  message: string;
  severity: 'info' | 'warning' | 'error';
  source?: string;
}

export class StateReader {
  private notifications: NotificationInfo[] = [];
  private maxNotifications = 50;

  constructor() {
    // Track notifications as they appear
    // Note: VS Code doesn't have a direct notification API for reading,
    // so we track them as they're shown through output channels
  }

  /** Record a notification for later retrieval. */
  recordNotification(
    message: string,
    severity: 'info' | 'warning' | 'error',
    source?: string
  ): void {
    this.notifications.push({ message, severity, source });
    if (this.notifications.length > this.maxNotifications) {
      this.notifications.shift();
    }
  }

  /** Get a snapshot of the current VS Code state. */
  async getState(): Promise<VSCodeState> {
    const activeEditor = vscode.window.activeTextEditor
      ? this.readEditor(vscode.window.activeTextEditor)
      : undefined;

    const visibleEditors = vscode.window.visibleTextEditors.map((e) =>
      this.readEditor(e)
    );

    const terminals: TerminalState[] = vscode.window.terminals.map((t) => ({
      name: t.name,
      processId: undefined, // processId is async, omit for snapshot speed
      isActive: t === vscode.window.activeTerminal,
    }));

    return {
      activeEditor,
      visibleEditors,
      terminals,
      notifications: [...this.notifications],
      sidebarVisible: true, // Can't easily read from API; assume visible
      panelVisible: true,
      activeViewId: undefined,
    };
  }

  /** Get accumulated notifications. */
  getNotifications(): NotificationInfo[] {
    return [...this.notifications];
  }

  /** Clear accumulated notifications. */
  clearNotifications(): void {
    this.notifications = [];
  }

  /**
   * Return info about all open webview / custom-editor tabs.
   * Useful for mapping VS Code tab labels to CDP webview targets.
   */
  getWebviewTabs(): Array<{ label: string; isActive: boolean; viewType?: string }> {
    const results: Array<{ label: string; isActive: boolean; viewType?: string }> = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputWebview) {
          results.push({ label: tab.label, isActive: tab.isActive, viewType: input.viewType });
        } else if (input instanceof vscode.TabInputCustom) {
          results.push({ label: tab.label, isActive: tab.isActive, viewType: input.viewType });
        }
      }
    }
    return results;
  }

  /**
   * Activate (bring to front) the first tab whose label contains `titleSubstring`
   * (case-insensitive). Returns the matched label, or throws if no match.
   */
  async activateTab(titleSubstring: string): Promise<string> {
    const needle = titleSubstring.toLowerCase();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.label.toLowerCase().includes(needle)) {
          // Opening the tab input brings it to front
          const input = tab.input;
          if (input instanceof vscode.TabInputCustom) {
            await vscode.window.showTextDocument(input.uri, { preview: false, preserveFocus: false });
          } else {
            // For webview panels and others, use the generic openEditors command
            // by focusing the group and cycling to the tab
            await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
            // Find index within group
            const idx = group.tabs.indexOf(tab);
            if (idx >= 0) {
              // openEditorAtIndex is 1-based
              await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', idx + 1);
            }
          }
          return tab.label;
        }
      }
    }
    const available = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .map((t) => t.label)
      .join(', ');
    throw new Error(`No tab found matching "${titleSubstring}". Open tabs: ${available}`);
  }

  private readEditor(editor: vscode.TextEditor): EditorState {
    return {
      fileName: editor.document.fileName,
      languageId: editor.document.languageId,
      content: editor.document.getText(),
      selections: editor.selections.map((s) => ({
        startLine: s.start.line,
        startCharacter: s.start.character,
        endLine: s.end.line,
        endCharacter: s.end.character,
      })),
      isDirty: editor.document.isDirty,
    };
  }
}
