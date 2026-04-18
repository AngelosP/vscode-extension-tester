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
