import * as vscode from 'vscode';

interface VSCodeState {
  activeEditor?: EditorState;
  visibleEditors: EditorState[];
  terminals: TerminalState[];
  notifications: NotificationInfo[];
  progress: ProgressState;
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

interface NotificationActionInfo {
  label: string;
  isCloseAffordance?: boolean;
}

interface NotificationInfo {
  id: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
  source?: string;
  actions: NotificationActionInfo[];
  selectedAction?: string;
  createdAt: number;
  updatedAt: number;
  active: boolean;
}

interface ProgressInfo {
  id: string;
  title?: string;
  location?: string;
  cancellable?: boolean;
  message?: string;
  increment?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  status: 'active' | 'completed' | 'failed' | 'canceled';
  error?: string;
}

interface ProgressState {
  active: ProgressInfo[];
  history: ProgressInfo[];
}

type MessageAction = string | vscode.MessageItem;
type NotificationResolver = (label: string) => boolean;

export class StateReader {
  private notifications: NotificationInfo[] = [];
  private readonly notificationResolvers = new Map<string, NotificationResolver>();
  private readonly progress = new Map<string, ProgressInfo>();
  private progressHistory: ProgressInfo[] = [];
  private readonly maxNotifications = 50;
  private readonly maxProgressHistory = 100;
  private notificationCounter = 0;
  private progressCounter = 0;

  register(): vscode.Disposable[] {
    const originalShowInformationMessage = vscode.window.showInformationMessage;
    const originalShowWarningMessage = vscode.window.showWarningMessage;
    const originalShowErrorMessage = vscode.window.showErrorMessage;
    const originalWithProgress = vscode.window.withProgress;

    (vscode.window as any).showInformationMessage = (...args: unknown[]) =>
      this.trackMessage(originalShowInformationMessage, 'info', args);
    (vscode.window as any).showWarningMessage = (...args: unknown[]) =>
      this.trackMessage(originalShowWarningMessage, 'warning', args);
    (vscode.window as any).showErrorMessage = (...args: unknown[]) =>
      this.trackMessage(originalShowErrorMessage, 'error', args);
    (vscode.window as any).withProgress = <R>(
      options: vscode.ProgressOptions,
      task: (
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        token: vscode.CancellationToken,
      ) => Thenable<R>,
    ): Thenable<R> => this.trackProgress(originalWithProgress, options, task);

    return [{
      dispose: () => {
        (vscode.window as any).showInformationMessage = originalShowInformationMessage;
        (vscode.window as any).showWarningMessage = originalShowWarningMessage;
        (vscode.window as any).showErrorMessage = originalShowErrorMessage;
        (vscode.window as any).withProgress = originalWithProgress;
      },
    }];
  }

  recordNotification(
    message: string,
    severity: 'info' | 'warning' | 'error',
    source?: string,
    actions: NotificationActionInfo[] = [],
  ): NotificationInfo {
    const now = Date.now();
    const notification: NotificationInfo = {
      id: `notification-${++this.notificationCounter}`,
      message,
      severity,
      source,
      actions,
      createdAt: now,
      updatedAt: now,
      active: true,
    };
    this.notifications.push(notification);
    if (this.notifications.length > this.maxNotifications) {
      const removed = this.notifications.shift();
      if (removed) this.notificationResolvers.delete(removed.id);
    }
    return notification;
  }

  getNotifications(): NotificationInfo[] {
    return this.notifications.map((notification) => ({
      ...notification,
      actions: [...notification.actions],
    }));
  }

  clearNotifications(): void {
    this.notifications = [];
    this.notificationResolvers.clear();
  }

  async clickNotificationAction(message: string, action: string): Promise<{ notification: NotificationInfo; action: string }> {
    const notification = [...this.notifications].reverse().find((candidate) =>
      candidate.message.toLowerCase().includes(message.toLowerCase()) &&
      candidate.actions.some((candidateAction) => labelsMatch(candidateAction.label, action))
    );

    if (!notification) {
      throw new Error(`Notification containing "${message}" with action "${action}" not found`);
    }

    const actionInfo = notification.actions.find((candidateAction) => labelsMatch(candidateAction.label, action));
    if (!actionInfo) throw new Error(`Notification action "${action}" not found`);

    const resolver = this.notificationResolvers.get(notification.id);
    if (!resolver || !resolver(actionInfo.label)) {
      throw new Error(`Notification "${notification.message}" does not have a pending action "${actionInfo.label}"`);
    }

    try { await vscode.commands.executeCommand('notifications.clearAll'); } catch { /* best effort */ }

    return { notification: { ...notification, actions: [...notification.actions] }, action: actionInfo.label };
  }

  getProgressState(): ProgressState {
    return {
      active: Array.from(this.progress.values()).map((item) => ({ ...item })),
      history: this.progressHistory.map((item) => ({ ...item })),
    };
  }

  clearProgress(): void {
    this.progress.clear();
    this.progressHistory = [];
  }

  async getState(): Promise<VSCodeState> {
    const activeEditor = vscode.window.activeTextEditor
      ? this.readEditor(vscode.window.activeTextEditor)
      : undefined;

    const visibleEditors = vscode.window.visibleTextEditors.map((editor) =>
      this.readEditor(editor)
    );

    const terminals: TerminalState[] = vscode.window.terminals.map((terminal) => ({
      name: terminal.name,
      processId: undefined,
      isActive: terminal === vscode.window.activeTerminal,
    }));

    return {
      activeEditor,
      visibleEditors,
      terminals,
      notifications: this.getNotifications(),
      progress: this.getProgressState(),
      sidebarVisible: true,
      panelVisible: true,
      activeViewId: undefined,
    };
  }

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

  async activateTab(titleSubstring: string): Promise<string> {
    const needle = titleSubstring.toLowerCase();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.label.toLowerCase().includes(needle)) {
          const input = tab.input;
          if (input instanceof vscode.TabInputCustom) {
            await vscode.window.showTextDocument(input.uri, { preview: false, preserveFocus: false });
          } else {
            await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
            const index = group.tabs.indexOf(tab);
            if (index >= 0) {
              await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', index + 1);
            }
          }
          return tab.label;
        }
      }
    }
    const available = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .map((tab) => tab.label)
      .join(', ');
    throw new Error(`No tab found matching "${titleSubstring}". Open tabs: ${available}`);
  }

  private trackMessage(
    original: (...args: any[]) => Thenable<any>,
    severity: 'info' | 'warning' | 'error',
    args: unknown[],
  ): Thenable<unknown> {
    const [message, ...rest] = args;
    const actions = extractMessageActions(rest);
    const notification = this.recordNotification(String(message), severity, undefined, actions.map((action) => ({
      label: getActionLabel(action),
      isCloseAffordance: typeof action === 'object' ? action.isCloseAffordance : undefined,
    })));

    let settled = false;
    let originalPromise: Thenable<unknown>;
    try {
      originalPromise = original.apply(vscode.window, args as any[]);
    } catch (err) {
      notification.active = false;
      notification.updatedAt = Date.now();
      throw err;
    }

    return new Promise((resolve, reject) => {
      this.notificationResolvers.set(notification.id, (label: string) => {
        if (settled) return false;
        const originalAction = actions.find((candidate) => labelsMatch(getActionLabel(candidate), label));
        if (!originalAction) return false;
        settled = true;
        this.notificationResolvers.delete(notification.id);
        notification.selectedAction = getActionLabel(originalAction);
        notification.updatedAt = Date.now();
        notification.active = false;
        resolve(originalAction);
        return true;
      });

      Promise.resolve(originalPromise).then(
        (result) => {
          if (settled) return;
          settled = true;
          this.notificationResolvers.delete(notification.id);
          if (result !== undefined) notification.selectedAction = getActionLabel(result);
          notification.updatedAt = Date.now();
          notification.active = false;
          resolve(result);
        },
        (err) => {
          if (settled) return;
          settled = true;
          this.notificationResolvers.delete(notification.id);
          notification.updatedAt = Date.now();
          notification.active = false;
          reject(err);
        },
      );
    });
  }

  private trackProgress<R>(
    original: typeof vscode.window.withProgress,
    options: vscode.ProgressOptions,
    task: (
      progress: vscode.Progress<{ message?: string; increment?: number }>,
      token: vscode.CancellationToken,
    ) => Thenable<R>,
  ): Thenable<R> {
    const entry = this.startProgress(options);
    return original.call(vscode.window, options, async (progress, token) => {
      let canceled = false;
      const cancellationDisposable = token.onCancellationRequested(() => {
        canceled = true;
        this.finishProgress(entry.id, 'canceled');
      });

      const wrappedProgress: vscode.Progress<{ message?: string; increment?: number }> = {
        report: (value) => {
          this.reportProgress(entry.id, value);
          progress.report(value);
        },
      };

      try {
        const result = await task(wrappedProgress, token);
        this.finishProgress(entry.id, canceled ? 'canceled' : 'completed');
        return result;
      } catch (err) {
        this.finishProgress(entry.id, canceled ? 'canceled' : 'failed', err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        cancellationDisposable.dispose();
      }
    }) as Thenable<R>;
  }

  private startProgress(options: vscode.ProgressOptions): ProgressInfo {
    const now = Date.now();
    const entry: ProgressInfo = {
      id: `progress-${++this.progressCounter}`,
      title: options.title,
      location: formatProgressLocation(options.location),
      cancellable: options.cancellable,
      createdAt: now,
      updatedAt: now,
      status: 'active',
    };
    this.progress.set(entry.id, entry);
    this.progressHistory.push(entry);
    if (this.progressHistory.length > this.maxProgressHistory) {
      this.progressHistory.shift();
    }
    return entry;
  }

  private reportProgress(id: string, value: { message?: string; increment?: number }): void {
    const entry = this.progress.get(id);
    if (!entry) return;
    entry.message = value.message ?? entry.message;
    if (value.increment !== undefined) entry.increment = (entry.increment ?? 0) + value.increment;
    entry.updatedAt = Date.now();
  }

  private finishProgress(id: string, status: ProgressInfo['status'], error?: string): void {
    const entry = this.progress.get(id) ?? this.progressHistory.find((item) => item.id === id);
    if (!entry || entry.completedAt !== undefined) return;
    entry.status = status;
    entry.error = error;
    entry.completedAt = Date.now();
    entry.updatedAt = entry.completedAt;
    this.progress.delete(id);
  }

  private readEditor(editor: vscode.TextEditor): EditorState {
    return {
      fileName: editor.document.fileName,
      languageId: editor.document.languageId,
      content: editor.document.getText(),
      selections: editor.selections.map((selection) => ({
        startLine: selection.start.line,
        startCharacter: selection.start.character,
        endLine: selection.end.line,
        endCharacter: selection.end.character,
      })),
      isDirty: editor.document.isDirty,
    };
  }
}

function extractMessageActions(args: unknown[]): MessageAction[] {
  const rest = [...args];
  if (isMessageOptions(rest[0])) {
    rest.shift();
  }
  return rest.filter((arg): arg is MessageAction => typeof arg === 'string' || isMessageItem(arg));
}

function isMessageOptions(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !('title' in value) && (
    'modal' in value || 'detail' in value
  );
}

function isMessageItem(value: unknown): value is vscode.MessageItem {
  return typeof value === 'object' && value !== null && 'title' in value;
}

function getActionLabel(action: unknown): string {
  if (typeof action === 'string') return action;
  if (isMessageItem(action)) return action.title;
  return String(action);
}

function labelsMatch(actual: string, expected: string): boolean {
  return actual.toLowerCase() === expected.toLowerCase() || actual.toLowerCase().includes(expected.toLowerCase());
}

function formatProgressLocation(location: vscode.ProgressLocation | { viewId: string }): string {
  if (typeof location === 'object' && location !== null && 'viewId' in location) {
    return `view:${location.viewId}`;
  }
  if (location === vscode.ProgressLocation.Notification) return 'notification';
  if (location === vscode.ProgressLocation.SourceControl) return 'sourceControl';
  if (location === vscode.ProgressLocation.Window) return 'window';
  return String(location);
}
