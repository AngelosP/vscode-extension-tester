import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ControllerClient } from '../../src/runner/controller-client.js';
import type { ParsedFeature, ParsedScenario, ParsedStep } from '../../src/runner/gherkin-parser.js';
import { TestRunner } from '../../src/runner/test-runner.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  WEBVIEW_BODY_TEXT,
  DATA_TABLE_TOOLBAR_TEXT,
  DATA_TABLE_BODY_TEXT,
  DATA_TABLE_EMPTY_TEXT,
  DATA_TABLE_NO_DATA_TEXT,
  SQL_FORM_BODY_TEXT,
  SECTION_SHELL_HEADER_TEXT,
  OUTPUT_CHANNEL_ACTIVATION,
  SELECTORS,
} from './fixtures/kusto-workbench-html.js';

// Mock the env module
vi.mock('../../src/agent/env.js', () => ({
  loadEnv: () => ({}),
}));

// ─── NativeUI mock ───────────────────────────────────────────────────────────
// The TestRunner lazily creates a NativeUIClient via requireNativeUI(). We mock
// the module so no real FlaUI bridge process is spawned.
const { mockNativeUIRef } = vi.hoisted(() => ({
  mockNativeUIRef: { current: null as Record<string, any> | null },
}));

vi.mock('../../src/runner/native-ui-client.js', () => {
  return {
    NativeUIClient: class MockNativeUIClient {
      constructor() {
        Object.assign(this, mockNativeUIRef.current);
      }
    },
  };
});

function resetMockNativeUI(): void {
  mockNativeUIRef.current = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    get isRunning() { return true; },
    findWindow: vi.fn().mockResolvedValue(null),
    findElement: vi.fn().mockResolvedValue(null),
    clickElement: vi.fn().mockResolvedValue(undefined),
    moveMouse: vi.fn().mockResolvedValue(undefined),
    clickMouse: vi.fn().mockResolvedValue(undefined),
    moveMouseInDevHost: vi.fn().mockResolvedValue(undefined),
    clickInDevHostAt: vi.fn().mockResolvedValue(undefined),
    setText: vi.fn().mockResolvedValue(undefined),
    focusWindow: vi.fn().mockResolvedValue(undefined),
    resizeWindow: vi.fn().mockResolvedValue(undefined),
    moveWindow: vi.fn().mockResolvedValue(undefined),
    listWindows: vi.fn().mockResolvedValue([]),
    getElementTree: vi.fn().mockResolvedValue({}),
    pressKey: vi.fn().mockResolvedValue(undefined),
    handleSaveAsDialog: vi.fn().mockResolvedValue(undefined),
    handleOpenDialog: vi.fn().mockResolvedValue(undefined),
    clickDialogButton: vi.fn().mockResolvedValue(undefined),
    clickInDevHost: vi.fn().mockResolvedValue(undefined),
    focusInDevHost: vi.fn().mockResolvedValue(undefined),
    resizeDevHost: vi.fn().mockResolvedValue(undefined),
    moveDevHost: vi.fn().mockResolvedValue(undefined),
    captureDevHostScreenshot: vi.fn().mockResolvedValue(undefined),
    getDevHostTree: vi.fn().mockResolvedValue({}),
  };
}

function getMockNativeUI() { return mockNativeUIRef.current!; }

// ─── CDP mock ────────────────────────────────────────────────────────────────
// The TestRunner lazily creates a CdpClient via requireCdp(). We mock the
// module so no real Chrome DevTools connection is needed. Each test configures
// `mockCdp` methods before running the step.
//
// vi.hoisted() makes the variable available in the hoisted vi.mock scope.
const { mockCdpRef } = vi.hoisted(() => ({
  mockCdpRef: { current: null as Record<string, any> | null },
}));

vi.mock('../../src/runner/cdp-client.js', () => {
  return {
    CdpClient: class MockCdpClient {
      constructor() {
        // Return the current mock object's properties
        Object.assign(this, mockCdpRef.current);
        // Copy getters
        const proto = Object.getOwnPropertyDescriptors(mockCdpRef.current!);
        for (const [key, desc] of Object.entries(proto)) {
          if (desc.get) {
            Object.defineProperty(this, key, desc);
          }
        }
      }
    },
  };
});

function resetMockCdp(): void {
  mockCdpRef.current = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    get isConnected() { return true; },
    waitForSelectorInWebview: vi.fn().mockResolvedValue(undefined),
    elementExistsInWebview: vi.fn().mockResolvedValue(false),
    getWebviewBodyText: vi.fn().mockResolvedValue(''),
    getTextInWebview: vi.fn().mockResolvedValue(''),
    evaluateInWebview: vi.fn().mockResolvedValue(undefined),
    clickInWebviewBySelector: vi.fn().mockResolvedValue(undefined),
    clickInWebviewByAccessibleText: vi.fn().mockResolvedValue(undefined),
    focusInWebviewBySelector: vi.fn().mockResolvedValue(undefined),
    scrollInWebview: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(null),
    getOutputChannelDescriptors: vi.fn().mockResolvedValue([]),
    readOutputChannelContent: vi.fn().mockResolvedValue(undefined),
    getWorkbenchQuickInputState: vi.fn().mockResolvedValue({ active: false }),
    selectWorkbenchQuickInputItem: vi.fn().mockResolvedValue({ selected: '', intercepted: false }),
    submitWorkbenchQuickInputText: vi.fn().mockResolvedValue({ entered: '', intercepted: false, accepted: true }),
    listWebviews: vi.fn().mockResolvedValue([]),
    listWebviewFrameContexts: vi.fn().mockResolvedValue([]),
    insertText: vi.fn().mockResolvedValue(undefined),
    pressKey: vi.fn().mockResolvedValue(undefined),
    moveMouse: vi.fn().mockResolvedValue(undefined),
    clickAt: vi.fn().mockResolvedValue(undefined),
  };
}

/** Shorthand to access the current mock CDP instance. */
function getMockCdp() { return mockCdpRef.current!; }

function makeStep(keyword: string, text: string): ParsedStep {
  return { keyword, text };
}

function makeScenario(name: string, steps: ParsedStep[], tags: string[] = []): ParsedScenario {
  return { name, steps, tags };
}

function makeFeature(
  name: string,
  scenarios: ParsedScenario[],
  backgroundSteps: ParsedStep[] = [],
): ParsedFeature {
  return {
    name,
    description: '',
    tags: [],
    backgroundSteps,
    scenarios,
    uri: 'test.feature',
  };
}

function createMockClient(): ControllerClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    executeCommand: vi.fn().mockResolvedValue({ executed: true }),
    startCommand: vi.fn().mockResolvedValue({ started: true, commandId: 'test' }),
    respondToQuickPick: vi.fn().mockResolvedValue({ selected: '' }),
    respondToInputBox: vi.fn().mockResolvedValue({ entered: '', intercepted: true }),
    respondToDialog: vi.fn().mockResolvedValue({ clicked: '' }),
    getQuickInputState: vi.fn().mockResolvedValue({ active: false }),
    selectQuickInputItem: vi.fn().mockResolvedValue({ selected: '', intercepted: true }),
    submitQuickInputText: vi.fn().mockResolvedValue({ entered: '', intercepted: true, accepted: true }),
    clickNotificationAction: vi.fn().mockResolvedValue({ action: '' }),
    getProgressState: vi.fn().mockResolvedValue({ active: [], history: [] }),
    getState: vi.fn().mockResolvedValue({
      activeEditor: { fileName: 'test.ts', languageId: 'typescript', content: 'test content', isDirty: false },
      terminals: [],
      notifications: [],
    }),
    getNotifications: vi.fn().mockResolvedValue([]),
    getOutputChannel: vi.fn().mockResolvedValue({ name: 'test', content: '' }),
    getOutputChannels: vi.fn().mockResolvedValue([]),
    getCapturedChannels: vi.fn().mockResolvedValue([]),
    startCaptureChannel: vi.fn().mockResolvedValue(undefined),
    stopCaptureChannel: vi.fn().mockResolvedValue(undefined),
    getOutputChannelOffset: vi.fn().mockResolvedValue(0),
    getDiagnostics: vi.fn().mockResolvedValue({ diag: [], channelSummary: {} }),
    getAllOutputContent: vi.fn().mockResolvedValue(''),
    handleAuth: vi.fn().mockResolvedValue({ status: 'ok' }),
    ping: vi.fn().mockResolvedValue({ status: 'ok' }),
    closeWindow: vi.fn().mockResolvedValue(undefined),
    listCommands: vi.fn().mockResolvedValue([]),
    getFullState: vi.fn().mockResolvedValue({}),
    setLogLevel: vi.fn().mockResolvedValue(undefined),
    getExtensionStatus: vi.fn().mockResolvedValue([]),
    typeText: vi.fn().mockResolvedValue(undefined),
    openFile: vi.fn().mockResolvedValue(undefined),
    addWorkspaceFolder: vi.fn().mockResolvedValue({ added: true }),
    pressKey: vi.fn().mockResolvedValue(undefined),
    setSetting: vi.fn().mockResolvedValue({ updated: true }),
    getSetting: vi.fn().mockResolvedValue({ key: '', value: null }),
    resetState: vi.fn().mockResolvedValue(undefined),
  } as unknown as ControllerClient;
}

describe('TestRunner', () => {
  let client: ControllerClient;
  let runner: TestRunner;

  beforeEach(() => {
    resetMockCdp();
    resetMockNativeUI();
    client = createMockClient();
    runner = new TestRunner(client);
  });

  afterEach(() => {
    runner.cleanup();
  });

  describe('runFeature()', () => {
    it('should run a feature with a single passing scenario', async () => {
      const feature = makeFeature('Test Feature', [
        makeScenario('Test Scenario', [
          makeStep('Given ', 'the VS Code is in a clean state'),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.name).toBe('Test Feature');
      expect(result.passed).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.scenarios).toHaveLength(1);
      expect(result.scenarios[0].status).toBe('passed');
    });

    it('should run multiple scenarios', async () => {
      const feature = makeFeature('Multi', [
        makeScenario('First', [
          makeStep('Given ', 'the VS Code is in a clean state'),
        ]),
        makeScenario('Second', [
          makeStep('Given ', 'the VS Code is in a clean state'),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.scenarios).toHaveLength(2);
      expect(result.passed).toBe(2);
    });

    it('should include background steps before each scenario', async () => {
      const feature = makeFeature(
        'With Background',
        [
          makeScenario('Test', [
            makeStep('When ', 'I execute command "test.command"'),
          ]),
        ],
        [makeStep('Given ', 'the VS Code is in a clean state')],
      );

      const result = await runner.runFeature(feature);

      // Background step + scenario step
      expect(result.scenarios[0].steps).toHaveLength(2);
      expect(result.scenarios[0].status).toBe('passed');
      expect((client.resetState as any)).toHaveBeenCalled();
    });

    it('should track duration', async () => {
      const feature = makeFeature('Duration', [
        makeScenario('Test', [
          makeStep('Given ', 'the VS Code is in a clean state'),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.scenarios[0].durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('runSingleStep()', () => {
    it('should return live artifacts, state, and a screenshot for a passing step', async () => {
      const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-ext-test-live-'));
      const liveRunner = new TestRunner(client, {}, artifactsDir);
      getMockNativeUI().captureDevHostScreenshot.mockResolvedValueOnce({
        success: true,
        filePath: path.join(artifactsDir, 'live-steps', 'shot.png'),
        width: 800,
        height: 600,
        strategy: 'CopyFromScreen',
        captureMethod: 'CopyFromScreen',
        devHostPid: 1234,
        windowProcessId: 2345,
        windowTitle: 'Live - Extension Development Host',
        windowBounds: { x: 10, y: 20, width: 800, height: 600 },
      });

      try {
        const result = await liveRunner.runSingleStep(makeStep('When ', 'I execute command "test.command"'), {
          stepIndex: 1,
          screenshotPolicy: 'always',
        });

        expect(result.status).toBe('passed');
        expect(result.stepIndex).toBe(1);
        expect(result.state?.terminals).toEqual([]);
        expect(result.artifacts.screenshots[0].kind).toBe('screenshot');
        expect(result.artifacts.screenshots[0].capture).toMatchObject({
          devHostPid: 1234,
          windowProcessId: 2345,
          windowTitle: 'Live - Extension Development Host',
          windowBounds: { x: 10, y: 20, width: 800, height: 600 },
          captureMethod: 'CopyFromScreen',
          captureSize: { width: 800, height: 600 },
        });
        expect(fs.existsSync(path.join(artifactsDir, 'live-steps'))).toBe(true);
        expect(result.artifacts.logs.some((artifact) => artifact.kind === 'log-manifest')).toBe(true);
        expect(getMockNativeUI().captureDevHostScreenshot).toHaveBeenCalled();
      } finally {
        liveRunner.cleanup();
        fs.rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('should preserve original failure when screenshot capture fails', async () => {
      const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-ext-test-live-'));
      const liveRunner = new TestRunner(client, {}, artifactsDir);
      (client.executeCommand as any).mockRejectedValueOnce(new Error('Command failed'));
      getMockNativeUI().captureDevHostScreenshot.mockRejectedValueOnce(new Error('Screenshot failed'));

      try {
        const result = await liveRunner.runSingleStep(makeStep('When ', 'I execute command "test.command"'), {
          stepIndex: 1,
          screenshotPolicy: 'always',
        });

        expect(result.status).toBe('failed');
        expect(result.error?.message).toBe('Command failed');
        expect(result.artifacts.warnings.join('\n')).toContain('Screenshot failed');
      } finally {
        liveRunner.cleanup();
        fs.rmSync(artifactsDir, { recursive: true, force: true });
      }
    });
  });

  describe('step dispatch', () => {
    it('should handle "the VS Code is in a clean state"', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Reset', [
          makeStep('Given ', 'the VS Code is in a clean state'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(client.resetState).toHaveBeenCalled();
    });

    it('should handle "I execute command" step', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Command', [
          makeStep('When ', 'I execute command "workbench.action.openSettings"'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(client.executeCommand).toHaveBeenCalledWith('workbench.action.openSettings');
    });

    it('should handle "I start command" step (fire-and-forget)', async () => {
      const feature = makeFeature('Test', [
        makeScenario('StartCommand', [
          makeStep('When ', 'I start command "kusto.openRemoteFile"'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(client.startCommand).toHaveBeenCalledWith('kusto.openRemoteFile');
    });

    it('should handle "I select from the QuickPick" step', async () => {
      const feature = makeFeature('Test', [
        makeScenario('QuickPick', [
          makeStep('When ', 'I select "TypeScript" from the QuickPick'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(client.respondToQuickPick).toHaveBeenCalledWith('TypeScript');
    });

    it('should handle "I type into the InputBox" step', async () => {
      const feature = makeFeature('Test', [
        makeScenario('InputBox', [
          makeStep('When ', 'I type "hello world" into the InputBox'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(client.submitQuickInputText).toHaveBeenCalledWith('hello world');
    });

    it('should handle explicit QuickInput selection step', async () => {
      const feature = makeFeature('Test', [
        makeScenario('QuickInput', [
          makeStep('When ', 'I select QuickInput item "Create new resource group"'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(client.selectQuickInputItem).toHaveBeenCalledWith('Create new resource group');
    });

    it('should wait for a QuickInput item', async () => {
      (client.getQuickInputState as any).mockResolvedValue({
        active: true,
        items: [{ id: 'item-1', label: 'Create new resource group', matchLabel: 'Create new resource group' }],
      });
      const feature = makeFeature('Test', [
        makeScenario('QuickInput wait', [
          makeStep('Then ', 'I wait for QuickInput item "Create new resource group"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.scenarios[0].status).toBe('passed');
    });

    it('should inspect visible workbench QuickInput when controller has no active session', async () => {
      (client.getQuickInputState as any).mockResolvedValue({ active: false });
      getMockCdp().getWorkbenchQuickInputState.mockResolvedValue({
        active: true,
        source: 'workbench',
        title: 'Select subscription',
        items: [{ id: 'workbench-item-0', label: 'Contoso', matchLabel: 'Contoso' }],
      });
      const feature = makeFeature('Test', [
        makeScenario('Inspect workbench QuickInput', [
          makeStep('When ', 'I inspect the QuickInput'),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.scenarios[0].status).toBe('passed');
      expect(result.scenarios[0].steps[0].outputLog).toContain('Select subscription');
    });

    it('should wait for visible workbench QuickInput items when controller state is inactive', async () => {
      (client.getQuickInputState as any).mockResolvedValue({ active: false });
      getMockCdp().getWorkbenchQuickInputState.mockResolvedValue({
        active: true,
        source: 'workbench',
        items: [{ id: 'workbench-item-0', label: 'Contoso subscription', matchLabel: 'Contoso subscription' }],
      });
      const feature = makeFeature('Test', [
        makeScenario('Workbench QuickInput wait', [
          makeStep('Then ', 'I wait for QuickInput item "Contoso"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.scenarios[0].status).toBe('passed');
    });

    it('should select visible workbench QuickInput item when controller has no session', async () => {
      (client.selectQuickInputItem as any).mockRejectedValue(new Error('No QuickPick is currently active'));
      getMockCdp().getWorkbenchQuickInputState.mockResolvedValue({ active: true, source: 'workbench' });
      const feature = makeFeature('Test', [
        makeScenario('Workbench QuickInput select', [
          makeStep('When ', 'I select QuickInput item "Contoso"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.scenarios[0].status).toBe('passed');
      expect(getMockCdp().selectWorkbenchQuickInputItem).toHaveBeenCalledWith('Contoso');
    });

    it('should submit text to visible workbench QuickInput when controller has no session', async () => {
      (client.submitQuickInputText as any).mockResolvedValueOnce({ entered: 'project-a', intercepted: false });
      getMockCdp().getWorkbenchQuickInputState.mockResolvedValue({ active: true, source: 'workbench' });
      const feature = makeFeature('Test', [
        makeScenario('Workbench QuickInput text', [
          makeStep('When ', 'I enter "project-a" in the QuickInput'),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.scenarios[0].status).toBe('passed');
      expect(getMockCdp().submitWorkbenchQuickInputText).toHaveBeenCalledWith('project-a');
    });

    it('should fallback to CDP when QuickInput text is not intercepted', async () => {
      (client.submitQuickInputText as any).mockResolvedValueOnce({ entered: 'hello', intercepted: false });
      const feature = makeFeature('Test', [
        makeScenario('QuickInput fallback', [
          makeStep('When ', 'I enter "hello" in the QuickInput'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(getMockCdp().insertText).toHaveBeenCalledWith('hello');
      expect(getMockCdp().pressKey).toHaveBeenCalledWith('Enter');
    });

    it('should handle "I click on the dialog" step', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Dialog', [
          makeStep('When ', 'I click "OK" on the dialog'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(client.respondToDialog).toHaveBeenCalledWith('OK');
    });

    it('should handle "I type" step (type text)', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Type', [
          makeStep('When ', 'I type "hello"'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(getMockCdp().insertText).toHaveBeenCalledWith('hello');
      expect(client.typeText).not.toHaveBeenCalled();
    });

    it('should handle "I press" step (press key)', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Press', [
          makeStep('When ', 'I press "Enter"'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(getMockCdp().pressKey).toHaveBeenCalledWith('Enter');
      expect(client.pressKey).not.toHaveBeenCalled();
    });

    it('should fallback to controller for multi-stroke key chords', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Press', [
          makeStep('When ', 'I press "Ctrl+K Ctrl+S"'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(client.pressKey).toHaveBeenCalledWith('Ctrl+K Ctrl+S');
      expect(getMockCdp().pressKey).not.toHaveBeenCalled();
    });

    it('should fallback to controller when CDP key dispatch fails', async () => {
      getMockCdp().pressKey.mockRejectedValueOnce(new Error('Unsupported key spec'));
      const feature = makeFeature('Test', [
        makeScenario('Press', [
          makeStep('When ', 'I press "Ctrl+/"'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(getMockCdp().pressKey).toHaveBeenCalledWith('Ctrl+/');
      expect(client.pressKey).toHaveBeenCalledWith('Ctrl+/');
    });

    it('should fallback to controller when CDP text insertion fails', async () => {
      getMockCdp().insertText.mockRejectedValueOnce(new Error('CDP unavailable'));
      const feature = makeFeature('Test', [
        makeScenario('Type', [
          makeStep('When ', 'I type "hello"'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(client.typeText).toHaveBeenCalledWith('hello');
    });

    it('should handle notification assertion step', async () => {
      (client.getNotifications as any).mockResolvedValue([
        { message: 'Hello world', severity: 'info' },
      ]);

      const feature = makeFeature('Test', [
        makeScenario('Notification', [
          makeStep('Then ', 'I should see notification "Hello"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.scenarios[0].status).toBe('passed');
    });

    it('should fail notification assertion when not found', async () => {
      (client.getNotifications as any).mockResolvedValue([]);

      const feature = makeFeature('Test', [
        makeScenario('No Notification', [
          makeStep('Then ', 'I should see notification "missing"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.scenarios[0].status).toBe('failed');
      expect(result.scenarios[0].steps[0].error?.message).toContain('missing');
    }, 10_000);

    it('should handle negative notification assertion', async () => {
      (client.getNotifications as any).mockResolvedValue([]);

      const feature = makeFeature('Test', [
        makeScenario('No Error', [
          makeStep('Then ', 'I should not see notification "error"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.scenarios[0].status).toBe('passed');
    });

    it('should fail negative notification assertion when notification exists', async () => {
      (client.getNotifications as any).mockResolvedValue([
        { message: 'An error occurred', severity: 'error' },
      ]);

      const feature = makeFeature('Test', [
        makeScenario('Has Error', [
          makeStep('Then ', 'I should not see notification "error"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.scenarios[0].status).toBe('failed');
    });

    it('should click a notification action', async () => {
      (client.getNotifications as any).mockResolvedValue([
        { message: 'Deploy failed', severity: 'error', active: true, actions: [{ label: 'Retry' }] },
      ]);
      const feature = makeFeature('Test', [
        makeScenario('Notification action', [
          makeStep('When ', 'I click "Retry" on notification "Deploy failed"'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(client.clickNotificationAction).toHaveBeenCalledWith('Deploy failed', 'Retry');
    });

    it('should poll before clicking a delayed notification action', async () => {
      (client.getNotifications as any)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { message: 'Deploy failed', severity: 'error', active: true, actions: [{ label: 'Retry' }] },
        ]);
      const feature = makeFeature('Test', [
        makeScenario('Delayed notification action', [
          makeStep('When ', 'I click "Retry" on notification "Deploy failed"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.scenarios[0].status).toBe('passed');
      expect(client.getNotifications).toHaveBeenCalledTimes(2);
      expect(client.clickNotificationAction).toHaveBeenCalledWith('Deploy failed', 'Retry');
    });

    it('should wait for completed progress', async () => {
      (client.getProgressState as any).mockResolvedValue({
        active: [],
        history: [{ id: 'progress-1', title: 'Deploying', status: 'completed', createdAt: 1, updatedAt: 2, completedAt: 2 }],
      });
      const feature = makeFeature('Test', [
        makeScenario('Progress', [
          makeStep('Then ', 'I wait for progress "Deploying" to complete'),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.scenarios[0].status).toBe('passed');
    });

    it('should handle editor content assertion', async () => {
      (client.getState as any).mockResolvedValue({
        activeEditor: { fileName: 'test.ts', languageId: 'typescript', content: 'const x = 42;', isDirty: false },
        terminals: [],
        notifications: [],
      });

      const feature = makeFeature('Test', [
        makeScenario('Editor', [
          makeStep('Then ', 'the editor should contain "const x"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.scenarios[0].status).toBe('passed');
    });

    it('should fail editor content assertion when no editor', async () => {
      (client.getState as any).mockResolvedValue({
        activeEditor: undefined,
        terminals: [],
        notifications: [],
      });

      const feature = makeFeature('Test', [
        makeScenario('No Editor', [
          makeStep('Then ', 'the editor should contain "anything"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.scenarios[0].status).toBe('failed');
      expect(result.scenarios[0].steps[0].error?.message).toContain('No active editor');
    });

    it('should handle output channel assertion', async () => {
      (client.getOutputChannel as any).mockResolvedValue({
        name: 'Test Channel',
        content: 'Server started on port 3000',
      });

      const feature = makeFeature('Test', [
        makeScenario('Output', [
          makeStep('Then ', 'the output channel "Test Channel" should contain "port 3000"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.scenarios[0].status).toBe('passed');
    });

    it('should handle negative output channel assertion', async () => {
      (client.getOutputChannel as any).mockResolvedValue({
        name: 'Test Channel',
        content: 'Server started successfully',
      });

      const feature = makeFeature('Test', [
        makeScenario('No Error Output', [
          makeStep('Then ', 'the output channel "Test Channel" should not contain "ERROR"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.scenarios[0].status).toBe('passed');
    });

    it('should handle output capture steps', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Capture', [
          makeStep('Given ', 'I capture the output channel "My Channel"'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(client.startCaptureChannel).toHaveBeenCalledWith('My Channel');
    });

    it('should handle stop capture step', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Stop Capture', [
          makeStep('Given ', 'I stop capturing the output channel "My Channel"'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(client.stopCaptureChannel).toHaveBeenCalledWith('My Channel');
    });

    it('should handle captured channel assertion', async () => {
      (client.getOutputChannel as any).mockResolvedValue({
        name: 'My Channel',
        content: 'some captured content',
      });

      const feature = makeFeature('Test', [
        makeScenario('Captured', [
          makeStep('Then ', 'the output channel "My Channel" should have been captured'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('passed');
    });

    it('should handle "I open file" step (via controller)', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Open File', [
          makeStep('When ', 'I open file "src/test.ts" in the editor'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(client.openFile).toHaveBeenCalled();
    });

    it('should handle "I add folder to the workspace" step', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Add Folder', [
          makeStep('When ', 'I add folder "/tmp/test-project" to the workspace'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(client.addWorkspaceFolder).toHaveBeenCalled();
    });

    it('should handle auth step', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Auth', [
          makeStep('Given ', 'I sign in with Microsoft as "user@example.com"'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(client.handleAuth).toHaveBeenCalledWith('microsoft', { username: 'user@example.com' });
    });

    it('should handle no-op setup steps', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Setup', [
          makeStep('Given ', 'VS Code is running'),
          makeStep('And ', 'extension test-ext is installed'),
          makeStep('And ', 'recording is enabled'),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.scenarios[0].status).toBe('passed');
    });

    it('should throw on unrecognized step', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Unknown', [
          makeStep('When ', 'I do something completely unknown and unmatched'),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.scenarios[0].status).toBe('failed');
      expect(result.scenarios[0].steps[0].error?.message).toContain('No step definition matches');
    });

    it('should skip remaining steps after a failure', async () => {
      (client.executeCommand as any).mockRejectedValueOnce(new Error('Command failed'));

      const feature = makeFeature('Test', [
        makeScenario('Fail and Skip', [
          makeStep('When ', 'I execute command "failing.command"'),
          makeStep('Then ', 'the VS Code is in a clean state'),
          makeStep('And ', 'I type "hello"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.scenarios[0].status).toBe('failed');
      expect(result.scenarios[0].steps[0].status).toBe('failed');
      expect(result.scenarios[0].steps[1].status).toBe('skipped');
      expect(result.scenarios[0].steps[2].status).toBe('skipped');
    });

    it('should fail and skip remaining steps when a step never settles', async () => {
      vi.useFakeTimers();
      const timeoutRunner = new TestRunner(
        client,
        {},
        undefined,
        undefined,
        undefined,
        undefined,
        { stepTimeoutMs: 100 },
      );
      getMockCdp().waitForSelectorInWebview.mockReturnValue(new Promise(() => {}));
      const feature = makeFeature('Test', [
        makeScenario('Timeout and Skip', [
          makeStep('When ', 'I wait for ".ready" in the webview'),
          makeStep('Then ', 'the VS Code is in a clean state'),
        ]),
      ]);

      try {
        const resultPromise = timeoutRunner.runFeature(feature);
        await vi.advanceTimersByTimeAsync(100);
        const result = await resultPromise;

        expect(result.scenarios[0].status).toBe('failed');
        expect(result.scenarios[0].steps[0].status).toBe('failed');
        expect(result.scenarios[0].steps[0].error?.message).toContain('Step timed out after 100ms');
        expect(result.scenarios[0].steps[1].status).toBe('skipped');
        expect(getMockCdp().disconnect).toHaveBeenCalled();
      } finally {
        timeoutRunner.cleanup();
        vi.useRealTimers();
      }
    });
  });

  describe('file operations', () => {
    const tmpDir = path.join(process.cwd(), '__test_tmp__');

    beforeEach(() => {
      fs.mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should create a file with content', async () => {
      const filePath = path.join(tmpDir, 'test-file.txt');

      const feature = makeFeature('Test', [
        makeScenario('Create File', [
          makeStep('Given ', `a file "${filePath}" exists with content "hello world"`),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('hello world');
    });

    it('should create a file with doc string content (for JSON / quotes)', async () => {
      const filePath = path.join(tmpDir, 'test-json.sqlx');
      const jsonContent = '{"kind":"sqlx","version":1,"state":{"sections":[{"type":"sql","query":"SELECT 1"}]}}';

      const feature = makeFeature('Test', [
        makeScenario('Create JSON File', [
          { keyword: 'Given ', text: `a file "${filePath}" exists with content:`, docString: jsonContent },
        ]),
      ]);

      await runner.runFeature(feature);

      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(jsonContent);
    });

    it('should create an empty file', async () => {
      const filePath = path.join(tmpDir, 'empty-file.txt');

      const feature = makeFeature('Test', [
        makeScenario('Create Empty', [
          makeStep('Given ', `a file "${filePath}" exists`),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('');
    });

    it('should delete a file', async () => {
      const filePath = path.join(tmpDir, 'to-delete.txt');
      fs.writeFileSync(filePath, 'delete me', 'utf-8');

      const feature = makeFeature('Test', [
        makeScenario('Delete File', [
          makeStep('When ', `I delete file "${filePath}"`),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('should assert file exists', async () => {
      const filePath = path.join(tmpDir, 'existing.txt');
      fs.writeFileSync(filePath, 'exists', 'utf-8');

      const feature = makeFeature('Test', [
        makeScenario('File Exists', [
          makeStep('Then ', `the file "${filePath}" should exist`),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.scenarios[0].status).toBe('passed');
    });

    it('should fail when file does not exist', async () => {
      const feature = makeFeature('Test', [
        makeScenario('File Missing', [
          makeStep('Then ', `the file "${tmpDir}/nonexistent.txt" should exist`),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.scenarios[0].status).toBe('failed');
    });

    it('should assert file contains text', async () => {
      const filePath = path.join(tmpDir, 'content.txt');
      fs.writeFileSync(filePath, 'hello world', 'utf-8');

      const feature = makeFeature('Test', [
        makeScenario('File Contains', [
          makeStep('Then ', `the file "${filePath}" should contain "hello"`),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.scenarios[0].status).toBe('passed');
    });

    it('should fail when file does not contain text', async () => {
      const filePath = path.join(tmpDir, 'content.txt');
      fs.writeFileSync(filePath, 'hello world', 'utf-8');

      const feature = makeFeature('Test', [
        makeScenario('File Not Contains', [
          makeStep('Then ', `the file "${filePath}" should contain "goodbye"`),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.scenarios[0].status).toBe('failed');
    });
  });

  describe('wait step', () => {
    it('should handle "I wait N seconds" step', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Wait', [
          makeStep('When ', 'I wait 1 second'),
        ]),
      ]);

      const start = Date.now();
      const result = await runner.runFeature(feature);
      const elapsed = Date.now() - start;

      expect(result.scenarios[0].status).toBe('passed');
      expect(elapsed).toBeGreaterThanOrEqual(900); // ~1 second with some tolerance
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Assertion / testing statement edge cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe('notification assertions', () => {
    it('should match on substring (partial match)', async () => {
      (client.getNotifications as any).mockResolvedValue([
        { message: 'Extension activated successfully', severity: 'info' },
      ]);

      const feature = makeFeature('Test', [
        makeScenario('Partial', [
          makeStep('Then ', 'I should see notification "activated"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('passed');
    });

    it('should be case-sensitive (positive assertion)', async () => {
      (client.getNotifications as any).mockResolvedValue([
        { message: 'Hello world', severity: 'info' },
      ]);

      const feature = makeFeature('Test', [
        makeScenario('Case', [
          makeStep('Then ', 'I should see notification "hello"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('failed');
      expect(result.scenarios[0].steps[0].error?.message).toContain('hello');
    }, 10_000);

    it('should find match among multiple notifications', async () => {
      (client.getNotifications as any).mockResolvedValue([
        { message: 'First notification', severity: 'info' },
        { message: 'Second important one', severity: 'info' },
        { message: 'Third notification', severity: 'info' },
      ]);

      const feature = makeFeature('Test', [
        makeScenario('Multi', [
          makeStep('Then ', 'I should see notification "important"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('passed');
    });

    it('should find notification that appears after polling', async () => {
      let callCount = 0;
      (client.getNotifications as any).mockImplementation(() => {
        callCount++;
        if (callCount < 3) return Promise.resolve([]);
        return Promise.resolve([{ message: 'Delayed notification', severity: 'info' }]);
      });

      const feature = makeFeature('Test', [
        makeScenario('Polling', [
          makeStep('Then ', 'I should see notification "Delayed"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('passed');
      expect(callCount).toBeGreaterThanOrEqual(3);
    }, 10_000);
  });

  describe('negative notification assertions', () => {
    it('should be case-insensitive (negative assertion)', async () => {
      (client.getNotifications as any).mockResolvedValue([
        { message: 'An ERROR occurred', severity: 'error' },
      ]);

      const feature = makeFeature('Test', [
        makeScenario('Case Insensitive', [
          makeStep('Then ', 'I should not see notification "error"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('failed');
      expect(result.scenarios[0].steps[0].error?.message).toContain('An ERROR occurred');
    });

    it('should match on substring (negative assertion)', async () => {
      (client.getNotifications as any).mockResolvedValue([
        { message: 'An error occurred in the system', severity: 'error' },
      ]);

      const feature = makeFeature('Test', [
        makeScenario('Substring', [
          makeStep('Then ', 'I should not see notification "err"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('failed');
    });
  });

  describe('editor content assertions', () => {
    it('should fail when editor content does not match', async () => {
      (client.getState as any).mockResolvedValue({
        activeEditor: { fileName: 'test.ts', languageId: 'typescript', content: 'const x = 42;', isDirty: false },
        terminals: [],
        notifications: [],
      });

      const feature = makeFeature('Test', [
        makeScenario('Mismatch', [
          makeStep('Then ', 'the editor should contain "let y"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('failed');
      expect(result.scenarios[0].steps[0].error?.message).toContain('does not contain');
    });

    it('should fail when editor has empty content', async () => {
      (client.getState as any).mockResolvedValue({
        activeEditor: { fileName: 'empty.ts', languageId: 'typescript', content: '', isDirty: false },
        terminals: [],
        notifications: [],
      });

      const feature = makeFeature('Test', [
        makeScenario('Empty', [
          makeStep('Then ', 'the editor should contain "anything"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('failed');
      expect(result.scenarios[0].steps[0].error?.message).toContain('does not contain');
    });

    it('should match substring in multiline content', async () => {
      (client.getState as any).mockResolvedValue({
        activeEditor: {
          fileName: 'multi.ts',
          languageId: 'typescript',
          content: 'line one\nline two\nline three',
          isDirty: false,
        },
        terminals: [],
        notifications: [],
      });

      const feature = makeFeature('Test', [
        makeScenario('Multiline', [
          makeStep('Then ', 'the editor should contain "line two"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('passed');
    });
  });

  describe('output channel assertions', () => {
    it('should fail when output channel does not contain expected text', async () => {
      (client.getOutputChannel as any).mockResolvedValue({
        name: 'My Channel',
        content: 'Server started on port 3000',
      });

      const feature = makeFeature('Test', [
        makeScenario('Fail', [
          makeStep('Then ', 'the output channel "My Channel" should contain "port 8080"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('failed');
      expect(result.scenarios[0].steps[0].error?.message).toContain('does not contain');
    });

    it('should fail when output channel has empty content', async () => {
      (client.getOutputChannel as any).mockResolvedValue({
        name: 'Empty Channel',
        content: '',
      });

      const feature = makeFeature('Test', [
        makeScenario('Empty', [
          makeStep('Then ', 'the output channel "Empty Channel" should contain "anything"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('failed');
    });

    it('should fail negative assertion when text IS present', async () => {
      (client.getOutputChannel as any).mockResolvedValue({
        name: 'My Channel',
        content: 'ERROR: something went wrong',
      });

      const feature = makeFeature('Test', [
        makeScenario('Negative Fail', [
          makeStep('Then ', 'the output channel "My Channel" should not contain "ERROR"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('failed');
      expect(result.scenarios[0].steps[0].error?.message).toContain('unexpectedly contains');
    });

    it('should pass negative assertion when channel is empty', async () => {
      (client.getOutputChannel as any).mockResolvedValue({
        name: 'Empty',
        content: '',
      });

      const feature = makeFeature('Test', [
        makeScenario('Negative Empty', [
          makeStep('Then ', 'the output channel "Empty" should not contain "anything"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('passed');
    });

    it('should fail captured channel assertion when content is empty', async () => {
      (client.getOutputChannel as any).mockResolvedValue({
        name: 'Uncaptured',
        content: '',
      });

      const feature = makeFeature('Test', [
        makeScenario('Not Captured', [
          makeStep('Then ', 'the output channel "Uncaptured" should have been captured'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('failed');
      expect(result.scenarios[0].steps[0].error?.message).toContain('was not captured');
    });
  });

  describe('webview text assertions', () => {
    it('should pass when webview contains expected text', async () => {
      getMockCdp().getWebviewBodyText.mockResolvedValue('Welcome to my extension dashboard');

      const feature = makeFeature('Test', [
        makeScenario('Contains', [
          makeStep('Then ', 'the webview should contain "dashboard"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('passed');
      expect(getMockCdp().getWebviewBodyText).toHaveBeenCalledWith(undefined);
    });

    it('should fail when webview does not contain expected text', async () => {
      getMockCdp().getWebviewBodyText.mockResolvedValue('Welcome to my extension');

      const feature = makeFeature('Test', [
        makeScenario('Not Found', [
          makeStep('Then ', 'the webview should contain "dashboard"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('failed');
      expect(result.scenarios[0].steps[0].error?.message).toContain('not found in any webview');
      expect(getMockCdp().getWebviewBodyText).toHaveBeenCalledWith(undefined);
    });

    it('should pass with titled webview containing text', async () => {
      getMockCdp().getWebviewBodyText.mockResolvedValue('Query results: 42 rows');

      const feature = makeFeature('Test', [
        makeScenario('Titled', [
          makeStep('Then ', 'the webview "Results Panel" should contain "42 rows"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('passed');
      expect(getMockCdp().getWebviewBodyText).toHaveBeenCalledWith('Results Panel');
    });

    it('should fail with titled webview not containing text', async () => {
      getMockCdp().getWebviewBodyText.mockResolvedValue('Query results: 0 rows');

      const feature = makeFeature('Test', [
        makeScenario('Titled Fail', [
          makeStep('Then ', 'the webview "Results Panel" should contain "42 rows"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('failed');
      expect(result.scenarios[0].steps[0].error?.message).toContain('webview "Results Panel"');
    });

    it('should fail when no webviews are open (empty body text)', async () => {
      getMockCdp().getWebviewBodyText.mockResolvedValue('');

      const feature = makeFeature('Test', [
        makeScenario('No Webview', [
          makeStep('Then ', 'the webview should contain "anything"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('failed');
      expect(result.scenarios[0].steps[0].error?.message).toContain('not found in any webview');
      expect(getMockCdp().getWebviewBodyText).toHaveBeenCalledWith(undefined);
    });

    it('should throw with title mismatch when titled webview not found', async () => {
      getMockCdp().getWebviewBodyText.mockRejectedValue(
        new Error('No webview found matching title "My Panel". Available webviews: none.'),
      );

      const feature = makeFeature('Test', [
        makeScenario('Title Mismatch', [
          makeStep('Then ', 'the webview "My Panel" should contain "anything"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('failed');
      expect(result.scenarios[0].steps[0].error?.message).toContain('No webview found matching title "My Panel"');
    });
  });

  describe('list webviews step', () => {
    it('should pass when listing webviews', async () => {
      getMockCdp().listWebviews.mockResolvedValue([
        { title: 'My Webview', url: 'vscode-webview://abcd1234' },
      ]);

      const feature = makeFeature('Test', [
        makeScenario('List', [
          makeStep('When ', 'I list the webviews'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('passed');
      expect(getMockCdp().listWebviews).toHaveBeenCalled();
    });

    it('should pass when no webviews are open', async () => {
      getMockCdp().listWebviews.mockResolvedValue([]);

      const feature = makeFeature('Test', [
        makeScenario('Empty', [
          makeStep('When ', 'I list the webviews'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('passed');
    });
  });

  describe('webview input steps', () => {
    it('should click a webview selector with default left click options', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Click webview', [
          makeStep('When ', 'I click "[data-testid=run]" in the webview'),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.scenarios[0].status).toBe('passed');
      expect(getMockCdp().clickInWebviewBySelector).toHaveBeenCalledWith('[data-testid=run]', undefined, {
        button: 'left',
        clickCount: 1,
      });
    });

    it('should right-click a selector in a titled webview', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Right click webview', [
          makeStep('When ', 'I right click ".row" in the webview "Dashboard"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.scenarios[0].status).toBe('passed');
      expect(getMockCdp().clickInWebviewBySelector).toHaveBeenCalledWith('.row', 'Dashboard', {
        button: 'right',
        clickCount: 1,
      });
    });

    it('should click a webview element by visible text', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Click webview text', [
          makeStep('When ', 'I click the webview element "Try In Playground"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.scenarios[0].status).toBe('passed');
      expect(getMockCdp().clickInWebviewByAccessibleText).toHaveBeenCalledWith('Try In Playground', undefined, {
        button: 'left',
        clickCount: 1,
      });
    });

    it('should pass explicit long webview eval timeouts through CDP', async () => {
      getMockCdp().evaluateInWebview.mockResolvedValue('diagnostic');
      const feature = makeFeature('Test', [
        makeScenario('Long eval', [
          makeStep('When ', 'I evaluate "waitForCompletionTargets(25000)" in the webview for 25 seconds'),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.scenarios[0].status).toBe('passed');
      expect(getMockCdp().evaluateInWebview).toHaveBeenCalledWith(
        'waitForCompletionTargets(25000)',
        undefined,
        { timeoutMs: 25_000 },
      );
    });

    it('should reject webview eval timeouts that consume the whole step budget', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Too long eval', [
          makeStep('When ', 'I evaluate "waitForCompletionTargets(30000)" in the webview for 30 seconds'),
        ]),
      ]);

      const result = await runner.runFeature(feature);

      expect(result.scenarios[0].status).toBe('failed');
      expect(result.scenarios[0].steps[0].error?.message).toContain('must be less than the step timeout');
      expect(getMockCdp().evaluateInWebview).not.toHaveBeenCalled();
    });
  });

  describe('element existence assertions', () => {
    it('should pass when element exists (immediate)', async () => {
      getMockCdp().waitForSelectorInWebview.mockResolvedValue(undefined);

      const feature = makeFeature('Test', [
        makeScenario('Exists', [
          makeStep('Then ', 'element ".my-button" should exist'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('passed');
      expect(getMockCdp().waitForSelectorInWebview).toHaveBeenCalledWith('.my-button', 5_000, undefined);
    });

    it('should fail when element does not appear within timeout', async () => {
      getMockCdp().waitForSelectorInWebview.mockRejectedValue(
        new Error('Selector ".missing" did not appear in webview within 5000ms'),
      );

      const feature = makeFeature('Test', [
        makeScenario('Timeout', [
          makeStep('Then ', 'element ".missing" should exist'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('failed');
      expect(result.scenarios[0].steps[0].error?.message).toContain('did not appear');
    });

    it('should pass with titled webview', async () => {
      getMockCdp().waitForSelectorInWebview.mockResolvedValue(undefined);

      const feature = makeFeature('Test', [
        makeScenario('Titled Exists', [
          makeStep('Then ', 'element ".status-bar" should exist in the webview "Dashboard"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('passed');
      expect(getMockCdp().waitForSelectorInWebview).toHaveBeenCalledWith('.status-bar', 5_000, 'Dashboard');
    });

    it('should pass "in the webview" without title', async () => {
      getMockCdp().waitForSelectorInWebview.mockResolvedValue(undefined);

      const feature = makeFeature('Test', [
        makeScenario('In Webview', [
          makeStep('Then ', 'element "#root" should exist in the webview'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('passed');
      expect(getMockCdp().waitForSelectorInWebview).toHaveBeenCalledWith('#root', 5_000, undefined);
    });

    it('should pass when element does not exist (negative)', async () => {
      getMockCdp().elementExistsInWebview.mockResolvedValue(false);

      const feature = makeFeature('Test', [
        makeScenario('Not Exists', [
          makeStep('Then ', 'element ".deleted-item" should not exist'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('passed');
    });

    it('should fail when element unexpectedly exists (negative)', async () => {
      getMockCdp().elementExistsInWebview.mockResolvedValue(true);

      const feature = makeFeature('Test', [
        makeScenario('Unexpected', [
          makeStep('Then ', 'element ".error-banner" should not exist'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('failed');
      expect(result.scenarios[0].steps[0].error?.message).toContain('unexpectedly exists');
    });

    it('should pass negative assertion with titled webview', async () => {
      getMockCdp().elementExistsInWebview.mockResolvedValue(false);

      const feature = makeFeature('Test', [
        makeScenario('Titled Not Exists', [
          makeStep('Then ', 'element ".spinner" should not exist in the webview "Dashboard"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('passed');
      expect(getMockCdp().elementExistsInWebview).toHaveBeenCalledWith('.spinner', 'Dashboard');
    });

    it('should handle selector with special characters', async () => {
      getMockCdp().waitForSelectorInWebview.mockResolvedValue(undefined);

      const feature = makeFeature('Test', [
        makeScenario('Special Chars', [
          makeStep('Then ', 'element "[data-testid=\'add-btn\']" should exist'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('passed');
      expect(getMockCdp().waitForSelectorInWebview).toHaveBeenCalledWith(
        "[data-testid='add-btn']", 5_000, undefined,
      );
    });
  });

  describe('element text assertions', () => {
    it('should pass when element text contains expected substring', async () => {
      getMockCdp().getTextInWebview.mockResolvedValue('Total: 42 items found');

      const feature = makeFeature('Test', [
        makeScenario('Text Match', [
          makeStep('Then ', 'element ".result-count" should have text "42 items"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('passed');
    });

    it('should fail when element text does not contain expected substring', async () => {
      getMockCdp().getTextInWebview.mockResolvedValue('Total: 0 items found');

      const feature = makeFeature('Test', [
        makeScenario('Text Mismatch', [
          makeStep('Then ', 'element ".result-count" should have text "42 items"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('failed');
      expect(result.scenarios[0].steps[0].error?.message).toContain('does not contain');
    });

    it('should fail when element is not found', async () => {
      getMockCdp().getTextInWebview.mockRejectedValue(
        new Error('Element not found in webview: .missing'),
      );

      const feature = makeFeature('Test', [
        makeScenario('Not Found', [
          makeStep('Then ', 'element ".missing" should have text "anything"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('failed');
      expect(result.scenarios[0].steps[0].error?.message).toContain('Element not found');
    });

    it('should pass with titled webview', async () => {
      getMockCdp().getTextInWebview.mockResolvedValue('Connected');

      const feature = makeFeature('Test', [
        makeScenario('Titled Text', [
          makeStep('Then ', 'element ".status" should have text "Connected" in the webview "Settings"'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('passed');
      expect(getMockCdp().getTextInWebview).toHaveBeenCalledWith('.status', 'Settings');
    });

    it('should pass without explicit webview title', async () => {
      getMockCdp().getTextInWebview.mockResolvedValue('Ready');

      const feature = makeFeature('Test', [
        makeScenario('No Title', [
          makeStep('Then ', 'element ".status" should have text "Ready" in the webview'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('passed');
      expect(getMockCdp().getTextInWebview).toHaveBeenCalledWith('.status', undefined);
    });
  });

  describe('env var interpolation in assertions', () => {
    it('should resolve ${VAR} from testData in assertion text', async () => {
      const customRunner = new TestRunner(client, { EXPECTED_TEXT: 'port 3000' });
      (client.getOutputChannel as any).mockResolvedValue({
        name: 'Server',
        content: 'Started on port 3000',
      });

      const feature = makeFeature('Test', [
        makeScenario('Env Var', [
          makeStep('Then ', 'the output channel "Server" should contain "${EXPECTED_TEXT}"'),
        ]),
      ]);

      const result = await customRunner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('passed');
      customRunner.cleanup();
    });

    it('should leave undefined vars as literal ${...}', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Undefined Var', [
          makeStep('When ', 'I execute command "${__VSCODE_EXT_TESTER_NONEXISTENT_XYZ__}"'),
        ]),
      ]);

      await runner.runFeature(feature);
      expect(client.executeCommand).toHaveBeenCalledWith('${__VSCODE_EXT_TESTER_NONEXISTENT_XYZ__}');
    });
  });

  describe('no-op setup steps', () => {
    it('should handle "debug capture is enabled" as no-op', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Debug Capture', [
          makeStep('Given ', 'debug capture is enabled'),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('passed');
    });
  });

  describe('file assertion edge cases', () => {
    const tmpDir = path.join(process.cwd(), '__test_tmp_assertions__');

    beforeEach(() => {
      fs.mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should fail "file should contain" when file does not exist', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Missing File', [
          makeStep('Then ', `the file "${tmpDir}/no-such-file.txt" should contain "hello"`),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('failed');
      expect(result.scenarios[0].steps[0].error?.message).toContain('File not found');
    });

    it('should fail "file should contain" when file is empty', async () => {
      const filePath = path.join(tmpDir, 'empty.txt');
      fs.writeFileSync(filePath, '', 'utf-8');

      const feature = makeFeature('Test', [
        makeScenario('Empty File', [
          makeStep('Then ', `the file "${filePath}" should contain "something"`),
        ]),
      ]);

      const result = await runner.runFeature(feature);
      expect(result.scenarios[0].status).toBe('failed');
      expect(result.scenarios[0].steps[0].error?.message).toContain('does not contain');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Real-world scenarios using Kusto Workbench HTML fixtures
  //
  // These tests use realistic content derived from the Kusto Workbench
  // extension's webview components (queryEditor.html, kw-data-table,
  // kw-sql-connection-form, kw-section-shell).
  //
  // Step coverage:
  //   - I should see notification           → extension lifecycle tests
  //   - I should not see notification        → extension lifecycle tests
  //   - the output channel should contain    → extension lifecycle tests
  //   - the output channel should not contain → extension lifecycle tests
  //   - the output channel should have been captured → extension lifecycle tests
  //   - the webview should contain           → webview body text tests
  //   - the webview "title" should contain   → webview body text tests
  //   - element "sel" should exist           → data table + SQL form tests
  //   - element "sel" should not exist       → data table tests
  //   - element "sel" should have text       → data table + SQL form tests
  //   - I evaluate "js" in the webview       → multi-step workflow test
  //   - I wait for "sel" in the webview      → multi-step workflow test
  //   - I click "sel" in the webview         → multi-step workflow test
  // ═══════════════════════════════════════════════════════════════════════════

  describe('real-world scenarios (Kusto Workbench fixtures)', () => {
    // ─── Extension lifecycle ───────────────────────────────────────────────

    describe('extension lifecycle', () => {
      it('should detect activation notification', async () => {
        (client.getNotifications as any).mockResolvedValue([
          { message: 'Kusto Workbench activated', severity: 'info' },
        ]);

        const feature = makeFeature('Kusto Activation', [
          makeScenario('Activation', [
            makeStep('Then ', 'I should see notification "Kusto Workbench activated"'),
          ]),
        ]);

        const result = await runner.runFeature(feature);
        expect(result.scenarios[0].status).toBe('passed');
      });

      it('should verify no error notifications after activation', async () => {
        (client.getNotifications as any).mockResolvedValue([
          { message: 'Kusto Workbench activated', severity: 'info' },
        ]);

        const feature = makeFeature('No Errors', [
          makeScenario('Clean Activation', [
            makeStep('Then ', 'I should not see notification "error"'),
          ]),
        ]);

        const result = await runner.runFeature(feature);
        expect(result.scenarios[0].status).toBe('passed');
      });

      it('should verify output channel contains activation log', async () => {
        (client.getOutputChannel as any).mockResolvedValue({
          name: 'Kusto Workbench',
          content: OUTPUT_CHANNEL_ACTIVATION,
        });

        const feature = makeFeature('Output Check', [
          makeScenario('Activation Log', [
            makeStep('Then ', 'the output channel "Kusto Workbench" should contain "Extension activated successfully"'),
          ]),
        ]);

        const result = await runner.runFeature(feature);
        expect(result.scenarios[0].status).toBe('passed');
      });

      it('should verify output channel does NOT contain errors', async () => {
        (client.getOutputChannel as any).mockResolvedValue({
          name: 'Kusto Workbench',
          content: OUTPUT_CHANNEL_ACTIVATION,
        });

        const feature = makeFeature('No Errors in Output', [
          makeScenario('Clean Output', [
            makeStep('Then ', 'the output channel "Kusto Workbench" should not contain "ERROR"'),
          ]),
        ]);

        const result = await runner.runFeature(feature);
        expect(result.scenarios[0].status).toBe('passed');
      });

      it('should verify output channel was captured', async () => {
        (client.getOutputChannel as any).mockResolvedValue({
          name: 'Kusto Workbench',
          content: OUTPUT_CHANNEL_ACTIVATION,
        });

        const feature = makeFeature('Captured', [
          makeScenario('Channel Captured', [
            makeStep('Then ', 'the output channel "Kusto Workbench" should have been captured'),
          ]),
        ]);

        const result = await runner.runFeature(feature);
        expect(result.scenarios[0].status).toBe('passed');
      });
    });

    // ─── Webview body text ─────────────────────────────────────────────────

    describe('webview body text', () => {
      it('should find section type buttons in webview body', async () => {
        getMockCdp().getWebviewBodyText.mockResolvedValue(WEBVIEW_BODY_TEXT);

        const feature = makeFeature('Body Text', [
          makeScenario('Section Buttons', [
            makeStep('Then ', 'the webview should contain "Kusto"'),
          ]),
        ]);

        const result = await runner.runFeature(feature);
        expect(result.scenarios[0].status).toBe('passed');
        expect(getMockCdp().getWebviewBodyText).toHaveBeenCalledWith(undefined);
      });

      it('should find "Transformation" in webview body', async () => {
        getMockCdp().getWebviewBodyText.mockResolvedValue(WEBVIEW_BODY_TEXT);

        const feature = makeFeature('Body Text', [
          makeScenario('Transformation Button', [
            makeStep('Then ', 'the webview should contain "Transformation"'),
          ]),
        ]);

        const result = await runner.runFeature(feature);
        expect(result.scenarios[0].status).toBe('passed');
      });

      it('should find text in titled webview', async () => {
        getMockCdp().getWebviewBodyText.mockResolvedValue(WEBVIEW_BODY_TEXT);

        const feature = makeFeature('Titled Webview', [
          makeScenario('Titled', [
            makeStep('Then ', 'the webview "Kusto Query Editor" should contain "Ask for a fix or feature"'),
          ]),
        ]);

        const result = await runner.runFeature(feature);
        expect(result.scenarios[0].status).toBe('passed');
        expect(getMockCdp().getWebviewBodyText).toHaveBeenCalledWith('Kusto Query Editor');
      });

      it('should fail when webview does not contain expected text', async () => {
        getMockCdp().getWebviewBodyText.mockResolvedValue(WEBVIEW_BODY_TEXT);

        const feature = makeFeature('Negative', [
          makeScenario('Not Found', [
            makeStep('Then ', 'the webview should contain "MongoDB"'),
          ]),
        ]);

        const result = await runner.runFeature(feature);
        expect(result.scenarios[0].status).toBe('failed');
        expect(result.scenarios[0].steps[0].error?.message).toContain('not found in any webview');
      });

      it('should find empty state text in data table webview', async () => {
        getMockCdp().getWebviewBodyText.mockResolvedValue(DATA_TABLE_EMPTY_TEXT);

        const feature = makeFeature('Empty Table', [
          makeScenario('No Rows', [
            makeStep('Then ', 'the webview should contain "No matching rows"'),
          ]),
        ]);

        const result = await runner.runFeature(feature);
        expect(result.scenarios[0].status).toBe('passed');
      });

      it('should find "No data" text when query returns nothing', async () => {
        getMockCdp().getWebviewBodyText.mockResolvedValue(DATA_TABLE_NO_DATA_TEXT);

        const feature = makeFeature('No Data', [
          makeScenario('No Data', [
            makeStep('Then ', 'the webview should contain "No data"'),
          ]),
        ]);

        const result = await runner.runFeature(feature);
        expect(result.scenarios[0].status).toBe('passed');
      });
    });

    // ─── Data table DOM ────────────────────────────────────────────────────

    describe('data table DOM', () => {
      it('should find table head element', async () => {
        // element "..." should exist → dispatches to waitForSelectorInWebview
        getMockCdp().waitForSelectorInWebview.mockResolvedValue(undefined);

        const feature = makeFeature('Data Table', [
          makeScenario('Table Head', [
            makeStep('Then ', `element "${SELECTORS.tableHead}" should exist`),
          ]),
        ]);

        const result = await runner.runFeature(feature);
        expect(result.scenarios[0].status).toBe('passed');
        expect(getMockCdp().waitForSelectorInWebview).toHaveBeenCalledWith(
          '#dt-head', 5_000, undefined,
        );
      });

      it('should find first data row by data-idx attribute', async () => {
        getMockCdp().waitForSelectorInWebview.mockResolvedValue(undefined);

        const feature = makeFeature('Data Table', [
          makeScenario('First Row', [
            makeStep('Then ', `element "${SELECTORS.firstRow}" should exist`),
          ]),
        ]);

        const result = await runner.runFeature(feature);
        expect(result.scenarios[0].status).toBe('passed');
        expect(getMockCdp().waitForSelectorInWebview).toHaveBeenCalledWith(
          "tr[data-idx='0']", 5_000, undefined,
        );
      });

      it('should verify empty state does not exist when data is present', async () => {
        // element "..." should not exist → dispatches to elementExistsInWebview
        getMockCdp().elementExistsInWebview.mockResolvedValue(false);

        const feature = makeFeature('Data Table', [
          makeScenario('Not Empty', [
            makeStep('Then ', `element "${SELECTORS.emptyBody}" should not exist`),
          ]),
        ]);

        const result = await runner.runFeature(feature);
        expect(result.scenarios[0].status).toBe('passed');
        expect(getMockCdp().elementExistsInWebview).toHaveBeenCalledWith('.empty-body', undefined);
      });

      it('should verify toolbar contains row count text', async () => {
        getMockCdp().getTextInWebview.mockResolvedValue(DATA_TABLE_TOOLBAR_TEXT);

        const feature = makeFeature('Data Table', [
          makeScenario('Toolbar Text', [
            makeStep('Then ', `element "${SELECTORS.toolbar}" should have text "3 rows"`),
          ]),
        ]);

        const result = await runner.runFeature(feature);
        expect(result.scenarios[0].status).toBe('passed');
        expect(getMockCdp().getTextInWebview).toHaveBeenCalledWith('.hbar', undefined);
      });

      it('should detect null cell exists in results', async () => {
        getMockCdp().waitForSelectorInWebview.mockResolvedValue(undefined);

        const feature = makeFeature('Data Table', [
          makeScenario('Null Cell', [
            makeStep('Then ', `element "${SELECTORS.nullCell}" should exist`),
          ]),
        ]);

        const result = await runner.runFeature(feature);
        expect(result.scenarios[0].status).toBe('passed');
        expect(getMockCdp().waitForSelectorInWebview).toHaveBeenCalledWith(
          '.null-cell', 5_000, undefined,
        );
      });
    });

    // ─── SQL connection form ───────────────────────────────────────────────

    describe('SQL connection form', () => {
      it('should find server input by data-testid', async () => {
        getMockCdp().waitForSelectorInWebview.mockResolvedValue(undefined);

        const feature = makeFeature('SQL Form', [
          makeScenario('Server Input', [
            makeStep('Then ', `element "${SELECTORS.sqlConnServer}" should exist`),
          ]),
        ]);

        const result = await runner.runFeature(feature);
        expect(result.scenarios[0].status).toBe('passed');
        expect(getMockCdp().waitForSelectorInWebview).toHaveBeenCalledWith(
          "[data-testid='sql-conn-server']", 5_000, undefined,
        );
      });

      it('should verify auth dropdown contains AAD text', async () => {
        getMockCdp().getTextInWebview.mockResolvedValue('AAD (Default)');

        const feature = makeFeature('SQL Form', [
          makeScenario('Auth Dropdown', [
            makeStep('Then ', `element "${SELECTORS.sqlConnAuth}" should have text "AAD"`),
          ]),
        ]);

        const result = await runner.runFeature(feature);
        expect(result.scenarios[0].status).toBe('passed');
        expect(getMockCdp().getTextInWebview).toHaveBeenCalledWith("[data-testid='sql-conn-auth']", undefined);
      });

      it('should find form field labels in SQL form body text', async () => {
        getMockCdp().getWebviewBodyText.mockResolvedValue(SQL_FORM_BODY_TEXT);

        const feature = makeFeature('SQL Form', [
          makeScenario('Form Body', [
            makeStep('Then ', 'the webview should contain "Server URL"'),
          ]),
        ]);

        const result = await runner.runFeature(feature);
        expect(result.scenarios[0].status).toBe('passed');
      });
    });

    // ─── Multi-step workflows ──────────────────────────────────────────────

    describe('multi-step workflows', () => {
      it('should run a full query-execute-verify scenario', async () => {
        // Mock controller responses
        (client.getNotifications as any).mockResolvedValue([]);
        (client.getOutputChannel as any).mockResolvedValue({
          name: 'Kusto Workbench',
          content: OUTPUT_CHANNEL_ACTIVATION,
        });

        // Mock CDP: wait for selector resolves, evaluate resolves, body has data
        getMockCdp().waitForSelectorInWebview.mockResolvedValue(undefined);
        getMockCdp().evaluateInWebview.mockResolvedValue('ok');
        getMockCdp().getWebviewBodyText.mockResolvedValue(DATA_TABLE_BODY_TEXT);
        getMockCdp().clickInWebviewBySelector.mockResolvedValue(undefined);
        // getTextInWebview: return different text based on selector
        getMockCdp().getTextInWebview.mockImplementation((sel: string) => {
          if (sel === SELECTORS.toolbar) return Promise.resolve(DATA_TABLE_TOOLBAR_TEXT);
          return Promise.resolve(SECTION_SHELL_HEADER_TEXT);
        });

        const feature = makeFeature('Full Query Workflow', [
          makeScenario('Run query and verify results', [
            // 1. Reset state
            makeStep('Given ', 'the extension is in a clean state'),
            // 2. Execute a command
            makeStep('When ', 'I execute command "kusto.openQueryEditor"'),
            // 3. Wait for webview element
            makeStep('And ', `I wait for "${SELECTORS.queriesContainer}" in the webview`),
            // 4. Click a button in the webview
            makeStep('And ', `I click "${SELECTORS.addKustoBtn}" in the webview`),
            // 5. Evaluate JS in the webview
            makeStep('And ', 'I evaluate "document.title" in the webview'),
            // 6. Assert element exists (polls via waitForSelectorInWebview)
            makeStep('Then ', `element "${SELECTORS.tableHead}" should exist`),
            // 7. Assert element text
            makeStep('And ', `element "${SELECTORS.toolbar}" should have text "3 rows"`),
            // 8. Assert webview body text
            makeStep('And ', 'the webview should contain "Flood"'),
            // 9. Assert output channel
            makeStep('And ', 'the output channel "Kusto Workbench" should contain "Extension activated"'),
          ]),
        ]);

        const result = await runner.runFeature(feature);
        expect(result.scenarios[0].status).toBe('passed');
        expect(result.scenarios[0].steps).toHaveLength(9);
        expect(result.scenarios[0].steps.every(s => s.status === 'passed')).toBe(true);

        // Verify the right controller methods were called
        expect(client.resetState).toHaveBeenCalled();
        expect(client.executeCommand).toHaveBeenCalledWith('kusto.openQueryEditor');
      });

      it('should run an output capture and assertion workflow', async () => {
        (client.getNotifications as any).mockResolvedValue([
          { message: 'Query completed: 3 rows', severity: 'info' },
        ]);
        (client.getOutputChannel as any).mockResolvedValue({
          name: 'Kusto Workbench',
          content: OUTPUT_CHANNEL_ACTIVATION,
        });

        const feature = makeFeature('Output Capture Workflow', [
          makeScenario('Capture and verify output', [
            makeStep('Given ', 'the extension is in a clean state'),
            makeStep('And ', 'I capture the output channel "Kusto Workbench"'),
            makeStep('When ', 'I execute command "kusto.openQueryEditor"'),
            makeStep('Then ', 'the output channel "Kusto Workbench" should contain "Extension activated"'),
            makeStep('And ', 'the output channel "Kusto Workbench" should not contain "ERROR"'),
            makeStep('And ', 'the output channel "Kusto Workbench" should have been captured'),
            makeStep('And ', 'I should see notification "Query completed"'),
            makeStep('And ', 'I should not see notification "failed"'),
          ]),
        ]);

        const result = await runner.runFeature(feature);
        expect(result.scenarios[0].status).toBe('passed');
        expect(result.scenarios[0].steps).toHaveLength(8);
        expect(result.scenarios[0].steps.every(s => s.status === 'passed')).toBe(true);
        expect(client.startCaptureChannel).toHaveBeenCalledWith('Kusto Workbench');
      });

      it('should run a scenario with background steps', async () => {
        (client.getOutputChannel as any).mockResolvedValue({
          name: 'Kusto Workbench',
          content: OUTPUT_CHANNEL_ACTIVATION,
        });
        getMockCdp().waitForSelectorInWebview.mockResolvedValue(undefined);
        getMockCdp().elementExistsInWebview.mockResolvedValue(false);
        getMockCdp().getTextInWebview.mockResolvedValue(DATA_TABLE_TOOLBAR_TEXT);

        const feature = makeFeature(
          'Query Verification',
          [
            makeScenario('Verify table structure', [
              makeStep('Then ', `element "${SELECTORS.tableHead}" should exist`),
              makeStep('And ', `element "${SELECTORS.firstRow}" should exist`),
              makeStep('And ', `element "${SELECTORS.emptyBody}" should not exist`),
              makeStep('And ', `element "${SELECTORS.toolbar}" should have text "3 rows"`),
            ]),
          ],
          // Background steps run before each scenario
          [
            makeStep('Given ', 'the extension is in a clean state'),
            makeStep('And ', 'I capture the output channel "Kusto Workbench"'),
          ],
        );

        const result = await runner.runFeature(feature);
        expect(result.scenarios[0].status).toBe('passed');
        // 2 background + 4 scenario = 6 total steps
        expect(result.scenarios[0].steps).toHaveLength(6);
        expect(client.resetState).toHaveBeenCalled();
        expect(client.startCaptureChannel).toHaveBeenCalledWith('Kusto Workbench');
      });
    });
  });

  // ─── Native UI steps ──────────────────────────────────────────────────────

  describe('native UI steps', () => {
    it('should handle "I click the element" step', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Click element', [
          makeStep('When ', 'I click the element "Open"'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(getMockNativeUI().clickInDevHost).toHaveBeenCalledWith('Open', undefined, {
        button: 'left',
        clickCount: 1,
      });
    });

    it('should handle raw mouse move and right-click steps', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Mouse', [
          makeStep('When ', 'I move the mouse to 100, 200'),
          makeStep('And ', 'I right click at 110, 210'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(getMockNativeUI().moveMouse).toHaveBeenCalledWith(100, 200);
      expect(getMockNativeUI().clickMouse).toHaveBeenCalledWith(110, 210, {
        button: 'right',
        clickCount: 1,
      });
      expect(getMockNativeUI().clickInDevHostAt).not.toHaveBeenCalled();
    });

    it('should route raw coordinate steps through the Dev Host window when configured', async () => {
      const windowRelativeRunner = new TestRunner(client, {}, undefined, undefined, undefined, 4242, {
        coordinateOrigin: 'devHostWindow',
      });
      const feature = makeFeature('Test', [
        makeScenario('Mouse', [
          makeStep('When ', 'I move the mouse to 100, 200'),
          makeStep('And ', 'I right click at 110, 210'),
        ]),
      ]);

      await windowRelativeRunner.runFeature(feature);

      expect(getMockNativeUI().moveMouseInDevHost).toHaveBeenCalledWith(100, 200);
      expect(getMockNativeUI().clickInDevHostAt).toHaveBeenCalledWith(110, 210, {
        button: 'right',
        clickCount: 1,
      });
      expect(getMockNativeUI().clickMouse).not.toHaveBeenCalledWith(110, 210, expect.anything());
    });

    it('should handle right-click accessible element steps', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Right click element', [
          makeStep('When ', 'I right click the element "Open"'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(getMockNativeUI().clickInDevHost).toHaveBeenCalledWith('Open', undefined, {
        button: 'right',
        clickCount: 1,
      });
    });

    it('should handle "I click the <name> <controlType>" step', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Click typed element', [
          makeStep('When ', 'I click the "Save" button'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(getMockNativeUI().clickInDevHost).toHaveBeenCalledWith('Save', 'button', {
        button: 'left',
        clickCount: 1,
      });
    });

    it('should handle "I save the file as" step', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Save As', [
          makeStep('When ', 'I save the file as "test.txt"'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(getMockNativeUI().handleSaveAsDialog).toHaveBeenCalledWith('test.txt');
    });

    it('should handle "I open the file" step', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Open File', [
          makeStep('When ', 'I open the file "data.csv"'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(getMockNativeUI().handleOpenDialog).toHaveBeenCalledWith('data.csv');
    });

    it('should handle "I click <button> on the <title> dialog" step', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Dialog button', [
          makeStep('When ', 'I click "OK" on the "Confirm" dialog'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(getMockNativeUI().clickDialogButton).toHaveBeenCalledWith('Confirm', 'OK');
    });

    it('should handle "I cancel the Save As dialog" step', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Cancel dialog', [
          makeStep('When ', 'I cancel the Save As dialog'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(getMockNativeUI().clickDialogButton).toHaveBeenCalledWith('Save', 'Cancel');
    });

    it('should handle "I cancel the Open dialog" step', async () => {
      // The implementation tries Save first, and if that throws, falls back to Open.
      // Make the Save attempt throw so it falls through to the Open dialog.
      getMockNativeUI().clickDialogButton = vi.fn()
        .mockRejectedValueOnce(new Error('not found'))
        .mockResolvedValueOnce(undefined);

      const feature = makeFeature('Test', [
        makeScenario('Cancel dialog', [
          makeStep('When ', 'I cancel the Open dialog'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(getMockNativeUI().clickDialogButton).toHaveBeenCalledWith('Open', 'Cancel');
    });

    it('should handle "I resize the Dev Host" step', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Resize', [
          makeStep('When ', 'I resize the Dev Host to 1280x720'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(getMockNativeUI().resizeDevHost).toHaveBeenCalledWith(1280, 720);
    });

    it('should handle "I move the window" step', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Move', [
          makeStep('When ', 'I move the window to 100, 200'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(getMockNativeUI().moveDevHost).toHaveBeenCalledWith(100, 200);
    });

    it('should capture screenshots through the native Dev Host target', async () => {
      const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-ext-test-artifacts-'));
      const screenshotRunner = new TestRunner(client, {}, artifactsDir);
      const feature = makeFeature('Test', [
        makeScenario('Screenshot', [
          makeStep('When ', 'I take a screenshot "resource picker"'),
        ]),
      ]);
      getMockNativeUI().captureDevHostScreenshot.mockResolvedValueOnce({
        success: true,
        filePath: path.join(artifactsDir, '1-resource_picker.png'),
        width: 1024,
        height: 768,
        strategy: 'PrintWindow',
        devHostPid: 4321,
        windowProcessId: 5432,
        windowTitle: 'Test - Extension Development Host',
        windowBounds: { x: 100, y: 200, width: 1024, height: 768 },
      });

      try {
        const result = await screenshotRunner.runFeature(feature);
        expect(getMockNativeUI().captureDevHostScreenshot).toHaveBeenCalledWith(
          path.join(artifactsDir, '1-resource_picker.png')
        );
        expect(result.scenarios[0].steps[0].artifacts?.screenshots[0].capture).toMatchObject({
          devHostPid: 4321,
          windowProcessId: 5432,
          windowTitle: 'Test - Extension Development Host',
          windowBounds: { x: 100, y: 200, width: 1024, height: 768 },
          captureMethod: 'PrintWindow',
          captureSize: { width: 1024, height: 768 },
        });
      } finally {
        screenshotRunner.cleanup();
        fs.rmSync(artifactsDir, { recursive: true, force: true });
      }
    });
  });
});
