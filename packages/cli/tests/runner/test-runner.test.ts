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
    getOutputChannelOffset: vi.fn().mockResolvedValue({ offset: 0 }),
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
});
