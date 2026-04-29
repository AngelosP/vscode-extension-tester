import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock vscode module
vi.mock('vscode', () => ({
  ProgressLocation: {
    Notification: 15,
    SourceControl: 1,
    Window: 10,
  },
  window: {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    terminals: [],
    activeTerminal: undefined,
    showInformationMessage: vi.fn().mockImplementation(() => new Promise(() => {})),
    showWarningMessage: vi.fn().mockImplementation(() => new Promise(() => {})),
    showErrorMessage: vi.fn().mockImplementation(() => new Promise(() => {})),
    withProgress: vi.fn().mockImplementation(async (_options, task) => task(
      { report: vi.fn() },
      { onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })) },
    )),
  },
  authentication: {
    onDidChangeSessions: vi.fn(() => ({ dispose: vi.fn() })),
    getSession: vi.fn(),
  },
  commands: {
    executeCommand: vi.fn().mockResolvedValue(undefined),
    getCommands: vi.fn().mockResolvedValue([]),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string, defaultValue: unknown) => defaultValue),
    })),
    fs: {
      stat: vi.fn().mockResolvedValue({}),
    },
  },
  debug: {
    registerDebugConfigurationProvider: vi.fn(() => ({ dispose: vi.fn() })),
  },
  Uri: {
    file: vi.fn((f: string) => ({ fsPath: f, scheme: 'file' })),
  },
}));

import { StateReader } from '../src/state-reader.js';

describe('StateReader', () => {
  let stateReader: StateReader;
  let vscode: any;

  beforeEach(async () => {
    stateReader = new StateReader();
    vscode = await import('vscode');
    vi.clearAllMocks();
  });

  describe('recordNotification()', () => {
    it('should record a notification', () => {
      stateReader.recordNotification('Hello', 'info', 'test');

      const notifications = stateReader.getNotifications();
      expect(notifications).toHaveLength(1);
      expect(notifications[0].message).toBe('Hello');
      expect(notifications[0].severity).toBe('info');
      expect(notifications[0].source).toBe('test');
      expect(notifications[0].actions).toEqual([]);
    });

    it('should record multiple notifications', () => {
      stateReader.recordNotification('First', 'info');
      stateReader.recordNotification('Second', 'warning');
      stateReader.recordNotification('Third', 'error');

      const notifications = stateReader.getNotifications();
      expect(notifications).toHaveLength(3);
    });

    it('should cap at maxNotifications (50)', () => {
      for (let i = 0; i < 60; i++) {
        stateReader.recordNotification(`Notification ${i}`, 'info');
      }

      const notifications = stateReader.getNotifications();
      expect(notifications).toHaveLength(50);
      // Oldest should be dropped
      expect(notifications[0].message).toBe('Notification 10');
    });

    it('should handle all severity levels', () => {
      stateReader.recordNotification('Info', 'info');
      stateReader.recordNotification('Warning', 'warning');
      stateReader.recordNotification('Error', 'error');

      const notifications = stateReader.getNotifications();
      expect(notifications.map((n) => n.severity)).toEqual(['info', 'warning', 'error']);
    });
  });

  describe('getNotifications()', () => {
    it('should return a copy of notifications', () => {
      stateReader.recordNotification('Test', 'info');

      const first = stateReader.getNotifications();
      const second = stateReader.getNotifications();

      expect(first).toEqual(second);
      expect(first).not.toBe(second); // Different array reference
    });
  });

  describe('clearNotifications()', () => {
    it('should clear all notifications', () => {
      stateReader.recordNotification('Test', 'info');
      stateReader.recordNotification('Test2', 'warning');

      stateReader.clearNotifications();

      expect(stateReader.getNotifications()).toHaveLength(0);
    });
  });

  describe('getState()', () => {
    it('should return state with notification list', async () => {
      stateReader.recordNotification('N1', 'info');

      const state = await stateReader.getState();

      expect(state.notifications).toHaveLength(1);
      expect(state.notifications[0].message).toBe('N1');
      expect(state.progress).toEqual({ active: [], history: [] });
    });

    it('should return empty terminals when none exist', async () => {
      const state = await stateReader.getState();
      expect(state.terminals).toEqual([]);
    });

    it('should return undefined activeEditor when none is open', async () => {
      const state = await stateReader.getState();
      expect(state.activeEditor).toBeUndefined();
    });
  });

  describe('registered notification hooks', () => {
    it('records notification actions and resolves with the original action object', async () => {
      const disposables = stateReader.register();
      const action = { title: 'Retry' };

      const promise = vscode.window.showInformationMessage('Deploy failed', action);
      const notifications = stateReader.getNotifications();

      expect(notifications[0]).toMatchObject({
        message: 'Deploy failed',
        severity: 'info',
        actions: [{ label: 'Retry' }],
        active: true,
      });

      await stateReader.clickNotificationAction('Deploy failed', 'Retry');

      await expect(promise).resolves.toBe(action);
      expect(stateReader.getNotifications()[0]).toMatchObject({
        selectedAction: 'Retry',
        active: false,
      });
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('notifications.clearAll');

      disposables.forEach((d) => d.dispose());
    });
  });

  describe('registered progress hooks', () => {
    it('tracks progress reports and completion', async () => {
      const disposables = stateReader.register();

      const result = await vscode.window.withProgress(
        { title: 'Deploying', location: vscode.ProgressLocation.Notification, cancellable: true },
        async (progress: any) => {
          progress.report({ message: 'Creating resources', increment: 25 });
          return 'ok';
        },
      );

      expect(result).toBe('ok');
      const progressState = stateReader.getProgressState();
      expect(progressState.active).toEqual([]);
      expect(progressState.history[0]).toMatchObject({
        title: 'Deploying',
        location: 'notification',
        message: 'Creating resources',
        increment: 25,
        status: 'completed',
      });

      disposables.forEach((d) => d.dispose());
    });
  });
});
