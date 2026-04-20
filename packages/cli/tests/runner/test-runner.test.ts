import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ControllerClient } from '../../src/runner/controller-client.js';
import type { ParsedFeature, ParsedScenario, ParsedStep } from '../../src/runner/gherkin-parser.js';
import { TestRunner } from '../../src/runner/test-runner.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Mock the env module
vi.mock('../../src/agent/env.js', () => ({
  loadEnv: () => ({}),
}));

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
    focusInWebviewBySelector: vi.fn().mockResolvedValue(undefined),
    scrollInWebview: vi.fn().mockResolvedValue(undefined),
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
    respondToQuickPick: vi.fn().mockResolvedValue({ selected: '' }),
    respondToInputBox: vi.fn().mockResolvedValue({ entered: '' }),
    respondToDialog: vi.fn().mockResolvedValue({ clicked: '' }),
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
    pressKey: vi.fn().mockResolvedValue(undefined),
    resetState: vi.fn().mockResolvedValue(undefined),
  } as unknown as ControllerClient;
}

describe('TestRunner', () => {
  let client: ControllerClient;
  let runner: TestRunner;

  beforeEach(() => {
    resetMockCdp();
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

      expect(client.respondToInputBox).toHaveBeenCalledWith('hello world');
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

      expect(client.typeText).toHaveBeenCalledWith('hello');
    });

    it('should handle "I press" step (press key)', async () => {
      const feature = makeFeature('Test', [
        makeScenario('Press', [
          makeStep('When ', 'I press "Enter"'),
        ]),
      ]);

      await runner.runFeature(feature);

      expect(client.pressKey).toHaveBeenCalledWith('Enter');
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
});
