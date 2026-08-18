import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock vscode module
vi.mock('vscode', () => {
  class MockTabInputCustom {
    constructor(
      readonly uri: unknown,
      readonly viewType: string,
    ) {}
  }

  class MockTabInputWebview {
    constructor(readonly viewType: string) {}
  }

  return {
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
    showTextDocument: vi.fn().mockResolvedValue(undefined),
    tabGroups: {
      all: [],
    },
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
  TabInputCustom: MockTabInputCustom,
  TabInputWebview: MockTabInputWebview,
  };
});

import { StateReader } from '../src/state-reader.js';

describe('StateReader', () => {
  let stateReader: StateReader;
  let vscode: any;

  beforeEach(async () => {
    stateReader = new StateReader();
    vscode = await import('vscode');
    vi.clearAllMocks();
    const knownWorkbenchCommands = new Set([
      'workbench.action.focusActiveEditorGroup',
      'workbench.action.focusFirstEditorGroup',
      'workbench.action.focusSecondEditorGroup',
      'workbench.action.focusThirdEditorGroup',
      'workbench.action.focusFourthEditorGroup',
      'workbench.action.focusFifthEditorGroup',
      'workbench.action.focusSixthEditorGroup',
      'workbench.action.focusSeventhEditorGroup',
      'workbench.action.focusEighthEditorGroup',
      'workbench.action.focusLastEditorGroup',
      'workbench.action.openEditorAtIndex',
    ]);
    vscode.commands.executeCommand.mockImplementation(async (command: string, ...args: any[]) => {
      if (command.startsWith('workbench.action.') && !knownWorkbenchCommands.has(command)) {
        throw new Error(`Unknown mocked workbench command: ${command}`);
      }
      if (command === 'vscode.openWith') {
        const [uri, viewType, options] = args;
        const group = vscode.window.tabGroups.all.find((candidate: any) => candidate.viewColumn === options.viewColumn);
        const tab = group?.tabs.find((candidate: any) =>
          candidate.input instanceof vscode.TabInputCustom &&
          candidate.input.uri === uri &&
          candidate.input.viewType === viewType);
        if (group && tab) activateMockTab(vscode.window.tabGroups.all, group, tab);
      } else if (command.startsWith('workbench.action.focus')) {
        const commandColumns: Record<string, number> = {
          'workbench.action.focusFirstEditorGroup': 1,
          'workbench.action.focusSecondEditorGroup': 2,
          'workbench.action.focusThirdEditorGroup': 3,
          'workbench.action.focusFourthEditorGroup': 4,
          'workbench.action.focusFifthEditorGroup': 5,
          'workbench.action.focusSixthEditorGroup': 6,
          'workbench.action.focusSeventhEditorGroup': 7,
          'workbench.action.focusEighthEditorGroup': 8,
        };
        const group = command === 'workbench.action.focusActiveEditorGroup'
          ? vscode.window.tabGroups.all.find((candidate: any) => candidate.isActive)
          : command === 'workbench.action.focusLastEditorGroup'
            ? vscode.window.tabGroups.all.at(-1)
            : vscode.window.tabGroups.all.find((candidate: any) => candidate.viewColumn === commandColumns[command]);
        if (group) {
          for (const candidate of vscode.window.tabGroups.all) candidate.isActive = candidate === group;
        }
      } else if (command === 'workbench.action.openEditorAtIndex') {
        const group = vscode.window.tabGroups.all.find((candidate: any) => candidate.isActive);
        const tab = group?.tabs[Number(args[0]) - 1];
        if (group && tab) activateMockTab(vscode.window.tabGroups.all, group, tab);
      }
      return undefined;
    });
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

  describe('activateTab()', () => {
    it('opens a matching custom tab with its exact view type in its owning group', async () => {
      const uri = { fsPath: 'C:/tmp/report.kqlx', scheme: 'file' };
      const tab = {
        label: 'report.kqlx',
        isActive: false,
        input: new vscode.TabInputCustom(uri, 'kusto.kqlxEditor'),
      };
      vscode.window.tabGroups.all = [
        { viewColumn: 1, tabs: [{ label: 'README.md', isActive: true, input: {} }] },
        { viewColumn: 2, tabs: [tab] },
      ];

      await expect(stateReader.activateTab('report')).resolves.toBe('report.kqlx');

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'vscode.openWith',
        uri,
        'kusto.kqlxEditor',
        { viewColumn: 2, preview: false, preserveFocus: false },
      );
      expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
      expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
        'workbench.action.openEditorAtIndex',
        expect.anything(),
      );
    });

    it('prefers an exact custom tab label over an earlier substring match', async () => {
      const kqlxUri = { fsPath: 'C:/tmp/smoke.kqlx', scheme: 'file' };
      const kqlUri = { fsPath: 'C:/tmp/smoke.kql', scheme: 'file' };
      vscode.window.tabGroups.all = [{
        viewColumn: 1,
        isActive: true,
        tabs: [
          { label: 'smoke.kqlx', isActive: false, input: new vscode.TabInputCustom(kqlxUri, 'kusto.kqlxEditor') },
          { label: 'smoke.kql', isActive: true, input: new vscode.TabInputCustom(kqlUri, 'kusto.kqlCompatEditor') },
        ],
      }];

      await expect(stateReader.activateTab('smoke.kql')).resolves.toBe('smoke.kql');

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'vscode.openWith',
        kqlUri,
        'kusto.kqlCompatEditor',
        { viewColumn: 1, preview: false, preserveFocus: false },
      );
      expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
        'vscode.openWith',
        kqlxUri,
        'kusto.kqlxEditor',
        expect.anything(),
      );
    });

    it('keeps index activation for a matching webview tab', async () => {
      const tab = {
        label: 'Results',
        isActive: false,
        input: new vscode.TabInputWebview('kusto.results'),
      };
      vscode.window.tabGroups.all = [{ viewColumn: 1, isActive: true, tabs: [tab] }];

      await expect(stateReader.activateTab('result')).resolves.toBe('Results');

      expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(
        1,
        'workbench.action.focusActiveEditorGroup',
      );
      expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(
        2,
        'workbench.action.openEditorAtIndex',
        1,
      );
      expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
    });

    it('focuses the owning group before activating a webview tab by index', async () => {
      const tab = {
        label: 'Results',
        isActive: false,
        input: new vscode.TabInputWebview('kusto.results'),
      };
      vscode.window.tabGroups.all = [
        { viewColumn: 1, isActive: true, tabs: [{ label: 'README', isActive: true, input: {} }] },
        { viewColumn: 2, isActive: false, tabs: [tab] },
      ];

      await expect(stateReader.activateTab('result')).resolves.toBe('Results');

      expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(
        1,
        'workbench.action.focusSecondEditorGroup',
      );
      expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(
        2,
        'workbench.action.openEditorAtIndex',
        1,
      );
    });

    it('reports available tabs when no label matches', async () => {
      vscode.window.tabGroups.all = [{
        viewColumn: 1,
        tabs: [
          { label: 'Foo', isActive: true, input: {} },
          { label: 'Bar', isActive: false, input: new vscode.TabInputWebview('demo.view') },
        ],
      }];

      await expect(stateReader.activateTab('baz')).rejects.toThrow(
        'No tab found matching "baz". Open tabs: Foo, Bar',
      );
    });

    it('rejects ambiguous partial labels before activating any tab', async () => {
      vscode.window.tabGroups.all = [{
        viewColumn: 1,
        isActive: true,
        tabs: [
          { label: 'Resource Picker - Left', isActive: true, input: new vscode.TabInputWebview('demo.left') },
          { label: 'Resource Picker - Right', isActive: false, input: new vscode.TabInputWebview('demo.right') },
        ],
      }];

      await expect(stateReader.activateTab('Resource Picker')).rejects.toThrow(
        'Tab activation is ambiguous for "Resource Picker"',
      );
      expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });

    it('fails when VS Code does not report the requested tab active', async () => {
      const tab = { label: 'Results', isActive: false, input: new vscode.TabInputWebview('demo.results') };
      vscode.window.tabGroups.all = [{ viewColumn: 1, isActive: true, tabs: [tab] }];
      vscode.commands.executeCommand.mockResolvedValue(undefined);

      await expect(stateReader.activateTab('Results')).rejects.toThrow(
        'VS Code did not activate tab "Results"',
      );
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

function activateMockTab(groups: any[], group: any, tab: any): void {
  for (const candidateGroup of groups) candidateGroup.isActive = candidateGroup === group;
  for (const candidateTab of group.tabs) candidateTab.isActive = candidateTab === tab;
}
