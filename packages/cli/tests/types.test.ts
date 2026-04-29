import { describe, it, expect } from 'vitest';
import {
  CONTROLLER_WS_PORT,
  CDP_PORT,
  VSCODE_LAUNCH_TIMEOUT_MS,
  WS_CONNECT_TIMEOUT_MS,
  STEP_TIMEOUT_MS,
  DEFAULT_RECORDING_FPS,
  CONTROLLER_EXTENSION_ID,
  DEFAULT_FEATURES_DIR,
} from '../src/types.js';
import type {
  StepResult,
  ScenarioResult,
  FeatureResult,
  TestRunResult,
  ControllerRequest,
  ControllerResponse,
  VSCodeState,
  NotificationInfo,
  RunOptions,
} from '../src/types.js';

describe('Types and Constants', () => {
  describe('constants', () => {
    it('should have correct default controller port', () => {
      expect(CONTROLLER_WS_PORT).toBe(9788);
    });

    it('should have correct CDP port', () => {
      expect(CDP_PORT).toBe(9222);
    });

    it('should have correct launch timeout', () => {
      expect(VSCODE_LAUNCH_TIMEOUT_MS).toBe(60_000);
    });

    it('should have correct WS connect timeout', () => {
      expect(WS_CONNECT_TIMEOUT_MS).toBe(15_000);
    });

    it('should have correct step timeout', () => {
      expect(STEP_TIMEOUT_MS).toBe(30_000);
    });

    it('should have correct recording FPS', () => {
      expect(DEFAULT_RECORDING_FPS).toBe(15);
    });

    it('should have correct controller extension ID', () => {
      expect(CONTROLLER_EXTENSION_ID).toBe(
        'vscode-extension-tester.vscode-extension-tester-controller'
      );
    });

    it('should have correct default features dir', () => {
      expect(DEFAULT_FEATURES_DIR).toBe('tests/vscode-extension-tester/e2e');
    });
  });

  describe('type shapes (compile-time checks via satisfies)', () => {
    it('should accept valid StepResult', () => {
      const step: StepResult = {
        keyword: 'Given ',
        text: 'the VS Code is in a clean state',
        status: 'passed',
        durationMs: 100,
      };
      expect(step.status).toBe('passed');
    });

    it('should accept StepResult with error', () => {
      const step: StepResult = {
        keyword: 'When ',
        text: 'I execute command "test"',
        status: 'failed',
        durationMs: 50,
        error: { message: 'Command not found', stack: 'at line 1' },
      };
      expect(step.error?.message).toBe('Command not found');
    });

    it('should accept valid ScenarioResult', () => {
      const scenario: ScenarioResult = {
        name: 'Test scenario',
        status: 'passed',
        steps: [],
        durationMs: 200,
        tags: ['@smoke'],
      };
      expect(scenario.tags).toContain('@smoke');
    });

    it('should accept valid FeatureResult', () => {
      const feature: FeatureResult = {
        name: 'Test feature',
        description: 'A test feature',
        scenarios: [],
        passed: 0,
        failed: 0,
        skipped: 0,
        durationMs: 0,
      };
      expect(feature.name).toBe('Test feature');
    });

    it('should accept valid TestRunResult', () => {
      const run: TestRunResult = {
        features: [],
        totalPassed: 5,
        totalFailed: 1,
        totalSkipped: 0,
        durationMs: 5000,
      };
      expect(run.totalPassed + run.totalFailed + run.totalSkipped).toBe(6);
    });

    it('should accept valid ControllerRequest', () => {
      const req: ControllerRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'executeCommand',
        params: { commandId: 'test' },
      };
      expect(req.jsonrpc).toBe('2.0');
    });

    it('should accept valid ControllerResponse', () => {
      const res: ControllerResponse = {
        jsonrpc: '2.0',
        id: 1,
        result: { executed: true },
      };
      expect(res.result).toEqual({ executed: true });
    });

    it('should accept ControllerResponse with error', () => {
      const res: ControllerResponse = {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32603, message: 'Internal error' },
      };
      expect(res.error?.code).toBe(-32603);
    });

    it('should accept valid VSCodeState', () => {
      const state: VSCodeState = {
        terminals: [{ name: 'bash', isActive: true }],
        notifications: [],
      };
      expect(state.terminals).toHaveLength(1);
    });

    it('should accept valid NotificationInfo', () => {
      const n: NotificationInfo = {
        id: 'notification-1',
        message: 'Extension activated',
        severity: 'info',
        source: 'my-extension',
        actions: [{ label: 'Open' }],
        active: true,
      };
      expect(n.severity).toBe('info');
    });

    it('should accept QuickInput and progress state on VSCodeState', () => {
      const state: VSCodeState = {
        terminals: [],
        notifications: [],
        progress: {
          active: [{ id: 'progress-1', title: 'Deploy', status: 'active', createdAt: 1, updatedAt: 1 }],
          history: [],
        },
      };
      expect(state.progress?.active[0].title).toBe('Deploy');
    });
  });
});
