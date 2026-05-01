import { describe, it, expect, vi, beforeEach } from 'vitest';

const nativeMocks = vi.hoisted(() => ({
  instances: [] as Array<{
    targetPid?: number;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    moveMouse: ReturnType<typeof vi.fn>;
    moveMouseInDevHost: ReturnType<typeof vi.fn>;
    clickMouse: ReturnType<typeof vi.fn>;
    clickInDevHostAt: ReturnType<typeof vi.fn>;
    selectFromDevHostPopup: ReturnType<typeof vi.fn>;
  }>,
  selectFromDevHostPopup: vi.fn(),
}));

const cdpMocks = vi.hoisted(() => ({
  instances: [] as Array<{
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    selectPopupMenuItem: ReturnType<typeof vi.fn>;
    stabilizeMonacoAfterPopupSelection: ReturnType<typeof vi.fn>;
  }>,
  selectPopupMenuItem: vi.fn(),
  stabilizeMonacoAfterPopupSelection: vi.fn(),
}));

const liveMocks = vi.hoisted(() => ({
  start: vi.fn(),
}));

vi.mock('../../src/runner/native-ui-client.js', () => ({
  NativeUIClient: class MockNativeUIClient {
    targetPid?: number;
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn();
    moveMouse = vi.fn().mockResolvedValue(undefined);
    moveMouseInDevHost = vi.fn().mockResolvedValue(undefined);
    clickMouse = vi.fn().mockResolvedValue(undefined);
    clickInDevHostAt = vi.fn().mockResolvedValue(undefined);
    selectFromDevHostPopup = nativeMocks.selectFromDevHostPopup;

    constructor() {
      nativeMocks.instances.push(this);
    }
  },
}));

vi.mock('../../src/runner/cdp-client.js', () => ({
  CdpClient: class MockCdpClient {
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn();
    selectPopupMenuItem = cdpMocks.selectPopupMenuItem;
    stabilizeMonacoAfterPopupSelection = cdpMocks.stabilizeMonacoAfterPopupSelection;

    constructor() {
      cdpMocks.instances.push(this);
    }
  },
}));

vi.mock('../../src/runner/live-session.js', () => ({
  LiveTestSession: {
    start: liveMocks.start,
  },
}));

import { TOOL_DEFINITIONS, executeToolCall, type ToolContext } from '../../src/agent/tools.js';

function makeContext(live = false, liveTargetPid: number | null = 9999): ToolContext {
  return {
    cwd: process.cwd(),
    env: {},
    targetPid: 4242,
    liveSession: live ? ({ getSummary: () => ({ cdpPort: 9333, targetPid: liveTargetPid ?? undefined }) } as never) : undefined,
  };
}

function makeContextWith(overrides: Partial<ToolContext>): ToolContext {
  return {
    cwd: process.cwd(),
    env: {},
    targetPid: 4242,
    ...overrides,
  };
}

describe('tools', () => {
  beforeEach(() => {
    nativeMocks.instances.length = 0;
    cdpMocks.instances.length = 0;
    nativeMocks.selectFromDevHostPopup.mockReset();
    nativeMocks.selectFromDevHostPopup.mockRejectedValue(new Error('Popup item not found'));
    cdpMocks.selectPopupMenuItem.mockReset();
    cdpMocks.selectPopupMenuItem.mockResolvedValue(undefined);
    cdpMocks.stabilizeMonacoAfterPopupSelection.mockReset();
    cdpMocks.stabilizeMonacoAfterPopupSelection.mockResolvedValue(undefined);
    liveMocks.start.mockReset();
    liveMocks.start.mockResolvedValue({
      client: {},
      getSummary: () => ({ cdpPort: 9333, targetPid: 9999, mode: 'launch' }),
    });
    vi.clearAllMocks();
  });

  describe('TOOL_DEFINITIONS', () => {
    it('should have at least 10 tool definitions', () => {
      expect(TOOL_DEFINITIONS.length).toBeGreaterThanOrEqual(10);
    });

    it('should all have type "function"', () => {
      for (const tool of TOOL_DEFINITIONS) {
        expect(tool.type).toBe('function');
      }
    });

    it('should all have a name', () => {
      for (const tool of TOOL_DEFINITIONS) {
        expect(tool.function.name).toBeTruthy();
      }
    });

    it('should all have a description', () => {
      for (const tool of TOOL_DEFINITIONS) {
        expect(tool.function.description).toBeTruthy();
      }
    });

    it('should all have parameters with type "object"', () => {
      for (const tool of TOOL_DEFINITIONS) {
        expect(tool.function.parameters).toBeDefined();
        expect(tool.function.parameters['type']).toBe('object');
      }
    });

    it('should have unique names', () => {
      const names = TOOL_DEFINITIONS.map((t) => t.function.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('should include core tools', () => {
      const names = TOOL_DEFINITIONS.map((t) => t.function.name);
      expect(names).toContain('execute_command');
      expect(names).toContain('start_command');
      expect(names).toContain('get_state');
      expect(names).toContain('get_notifications');
      expect(names).toContain('read_source_file');
      expect(names).toContain('write_feature_file');
      expect(names).toContain('run_test');
    });

    it('should include live Gherkin tools', () => {
      const names = TOOL_DEFINITIONS.map((t) => t.function.name);
      expect(names).toContain('start_live_session');
      expect(names).toContain('run_gherkin_step');
      expect(names).toContain('run_gherkin_script');
      expect(names).toContain('run_extension_host_script');
      expect(names).toContain('reset_live_session');
      expect(names).toContain('end_live_session');
    });

    it('should expose profile options and semantic webview click targets in tool schemas', () => {
      const startLive = TOOL_DEFINITIONS.find(tool => tool.function.name === 'start_live_session')!;
      const click = TOOL_DEFINITIONS.find(tool => tool.function.name === 'click')!;

      expect(startLive.function.parameters.properties).toHaveProperty('reuseNamedProfile');
      expect(startLive.function.parameters.properties).toHaveProperty('reuseOrCreateNamedProfile');
      expect((click.function.parameters.properties.target as any).enum).toEqual(
        expect.arrayContaining(['webviewText', 'webviewAccessibleText']),
      );
    });

    it('should include memory tools', () => {
      const names = TOOL_DEFINITIONS.map((t) => t.function.name);
      expect(names).toContain('read_memory');
      expect(names).toContain('write_memory');
      expect(names).toContain('append_memory');
    });

    it('should include UI interaction tools', () => {
      const names = TOOL_DEFINITIONS.map((t) => t.function.name);
      expect(names).toContain('respond_to_quickpick');
      expect(names).toContain('inspect_quickinput');
      expect(names).toContain('select_quickinput_item');
      expect(names).toContain('submit_quickinput_text');
      expect(names).toContain('respond_to_inputbox');
      expect(names).toContain('respond_to_dialog');
      expect(names).toContain('click_notification_action');
      expect(names).toContain('get_progress');
      expect(names).toContain('move_mouse');
      expect(names).toContain('click');
      expect(names).toContain('press_key');
      expect(names).toContain('type_text');
    });

    it('should have required fields specified for tools that need them', () => {
      const executeCmd = TOOL_DEFINITIONS.find((t) => t.function.name === 'execute_command')!;
      expect(executeCmd.function.parameters['required']).toContain('commandId');

      const readFile = TOOL_DEFINITIONS.find((t) => t.function.name === 'read_source_file')!;
      expect(readFile.function.parameters['required']).toContain('path');

      const writeFeature = TOOL_DEFINITIONS.find((t) => t.function.name === 'write_feature_file')!;
      expect(writeFeature.function.parameters['required']).toContain('path');
      expect(writeFeature.function.parameters['required']).toContain('content');

      const moveMouse = TOOL_DEFINITIONS.find((t) => t.function.name === 'move_mouse')!;
      expect(moveMouse.function.parameters['required']).toEqual(['x', 'y']);

      const pressKey = TOOL_DEFINITIONS.find((t) => t.function.name === 'press_key')!;
      expect(pressKey.function.parameters['required']).toEqual(['key']);

      const typeText = TOOL_DEFINITIONS.find((t) => t.function.name === 'type_text')!;
      expect(typeText.function.parameters['required']).toEqual(['text']);

      const selectQuickInput = TOOL_DEFINITIONS.find((t) => t.function.name === 'select_quickinput_item')!;
      expect(selectQuickInput.function.parameters['required']).toEqual(['label']);

      const submitQuickInput = TOOL_DEFINITIONS.find((t) => t.function.name === 'submit_quickinput_text')!;
      expect(submitQuickInput.function.parameters['required']).toEqual(['value']);

      const clickNotification = TOOL_DEFINITIONS.find((t) => t.function.name === 'click_notification_action')!;
      expect(clickNotification.function.parameters['required']).toEqual(['message', 'action']);

      const runGherkinStep = TOOL_DEFINITIONS.find((t) => t.function.name === 'run_gherkin_step')!;
      expect(runGherkinStep.function.parameters['required']).toEqual(['step']);

      const runGherkinScript = TOOL_DEFINITIONS.find((t) => t.function.name === 'run_gherkin_script')!;
      expect(runGherkinScript.function.parameters['required']).toEqual(['script']);
    });
  });

  describe('executeToolCall coordinate tools', () => {
    it('should reject missing reuseNamedProfile before starting a live session', async () => {
      const result = await executeToolCall('start_live_session', JSON.stringify({
        mode: 'auto',
        reuseNamedProfile: 'missing-profile',
      }), makeContextWith({ cwd: process.cwd() }));

      expect(result).toContain('Profile "missing-profile" not found');
      expect(liveMocks.start).not.toHaveBeenCalled();
    });

    it('should reject conflicting profile options before starting a live session', async () => {
      const result = await executeToolCall('start_live_session', JSON.stringify({
        mode: 'auto',
        reuseNamedProfile: 'one',
        reuseOrCreateNamedProfile: 'two',
      }), makeContextWith({ cwd: process.cwd() }));

      expect(result).toContain('Only one profile strategy can be used at a time');
      expect(liveMocks.start).not.toHaveBeenCalled();
    });

    it('should reject profile flags with attach live sessions', async () => {
      const result = await executeToolCall('start_live_session', JSON.stringify({
        mode: 'attach',
        reuseOrCreateNamedProfile: 'profile',
      }), makeContextWith({ cwd: process.cwd() }));

      expect(result).toContain('Profile flags are not compatible with --attach-devhost');
      expect(liveMocks.start).not.toHaveBeenCalled();
    });

    it('should keep move_mouse as absolute screen coordinates without a live session', async () => {
      const result = await executeToolCall('move_mouse', JSON.stringify({ x: 10, y: 20 }), makeContext());

      expect(result).toBe('Mouse moved to 10, 20');
      expect(nativeMocks.instances).toHaveLength(1);
      expect(nativeMocks.instances[0].targetPid).toBe(4242);
      expect(nativeMocks.instances[0].moveMouse).toHaveBeenCalledWith(10, 20);
      expect(nativeMocks.instances[0].moveMouseInDevHost).not.toHaveBeenCalled();
      expect(nativeMocks.instances[0].stop).toHaveBeenCalled();
    });

    it('should route move_mouse through the live Dev Host window when a live session exists', async () => {
      const result = await executeToolCall('move_mouse', JSON.stringify({ x: 10, y: 20 }), makeContext(true));

      expect(result).toBe('Mouse moved to 10, 20');
      expect(nativeMocks.instances).toHaveLength(1);
      expect(nativeMocks.instances[0].targetPid).toBe(9999);
      expect(nativeMocks.instances[0].moveMouseInDevHost).toHaveBeenCalledWith(10, 20);
      expect(nativeMocks.instances[0].moveMouse).not.toHaveBeenCalled();
    });

    it('should fail closed for live move_mouse when the live session has no target PID', async () => {
      const result = await executeToolCall('move_mouse', JSON.stringify({ x: 10, y: 20 }), makeContext(true, null));

      expect(result).toContain('Live session target PID is unavailable');
      expect(nativeMocks.instances).toHaveLength(1);
      expect(nativeMocks.instances[0].start).not.toHaveBeenCalled();
    });

    it('should keep coordinate clicks as absolute screen coordinates without a live session', async () => {
      const result = await executeToolCall('click', JSON.stringify({
        target: 'coordinates',
        x: 30,
        y: 40,
        button: 'right',
        reason: 'semantic target unavailable',
      }), makeContext());

      expect(result).toBe('right click sent to 30, 40');
      expect(nativeMocks.instances).toHaveLength(1);
      expect(nativeMocks.instances[0].clickMouse).toHaveBeenCalledWith(30, 40, { button: 'right', clickCount: 1 });
      expect(nativeMocks.instances[0].clickInDevHostAt).not.toHaveBeenCalled();
    });

    it('should execute extension-host live session scripts', async () => {
      const liveSession = {
        runExtensionHostScript: vi.fn().mockResolvedValue({ ok: true, value: 'ready', durationMs: 2 }),
      };
      const result = await executeToolCall('run_extension_host_script', JSON.stringify({
        script: 'return vscode.env.appName;',
        timeoutMs: 5_000,
      }), makeContextWith({ liveSession: liveSession as never }));

      expect(result).toContain('ready');
      expect(liveSession.runExtensionHostScript).toHaveBeenCalledWith('return vscode.env.appName;', 5_000);
    });

    it('should route coordinate clicks through the live Dev Host window when a live session exists', async () => {
      const result = await executeToolCall('click', JSON.stringify({
        target: 'coordinates',
        x: 30,
        y: 40,
        clickCount: 2,
        reason: 'semantic target unavailable',
      }), makeContext(true));

      expect(result).toBe('left click sent to 30, 40');
      expect(nativeMocks.instances).toHaveLength(1);
      expect(nativeMocks.instances[0].targetPid).toBe(9999);
      expect(nativeMocks.instances[0].clickInDevHostAt).toHaveBeenCalledWith(30, 40, { button: 'left', clickCount: 2 });
      expect(nativeMocks.instances[0].clickMouse).not.toHaveBeenCalled();
    });

    it('should stabilize Monaco after native select_popup_item succeeds', async () => {
      nativeMocks.selectFromDevHostPopup.mockResolvedValue('StormEvents');

      const result = await executeToolCall('select_popup_item', JSON.stringify({ label: 'StormEvents' }), makeContext());

      expect(result).toBe('Selected popup item: StormEvents');
      expect(nativeMocks.instances[0].selectFromDevHostPopup).toHaveBeenCalledWith('StormEvents', 3000);
      expect(cdpMocks.instances).toHaveLength(1);
      expect(cdpMocks.instances[0].stabilizeMonacoAfterPopupSelection).toHaveBeenCalled();
      expect(cdpMocks.instances[0].selectPopupMenuItem).not.toHaveBeenCalled();
    });

    it('should keep select_popup_item successful when native stabilization fails', async () => {
      nativeMocks.selectFromDevHostPopup.mockResolvedValue('StormEvents');
      cdpMocks.stabilizeMonacoAfterPopupSelection.mockRejectedValueOnce(new Error('CDP unavailable'));

      const result = await executeToolCall('select_popup_item', JSON.stringify({ label: 'StormEvents' }), makeContext());

      expect(result).toBe('Selected popup item: StormEvents');
      expect(cdpMocks.instances).toHaveLength(1);
      expect(cdpMocks.instances[0].stabilizeMonacoAfterPopupSelection).toHaveBeenCalled();
      expect(cdpMocks.instances[0].selectPopupMenuItem).not.toHaveBeenCalled();
    });

    it('should reject missing or blank select_popup_item labels', async () => {
      const missing = await executeToolCall('select_popup_item', JSON.stringify({}), makeContext());
      const blank = await executeToolCall('select_popup_item', JSON.stringify({ label: '   ' }), makeContext());

      expect(missing).toContain('Missing required string argument: label');
      expect(blank).toContain('Missing required string argument: label');
      expect(nativeMocks.instances).toHaveLength(0);
      expect(cdpMocks.instances).toHaveLength(0);
    });

    it('should fail closed for live coordinate clicks when the live session has no target PID', async () => {
      const result = await executeToolCall('click', JSON.stringify({
        target: 'coordinates',
        x: 30,
        y: 40,
        reason: 'semantic target unavailable',
      }), makeContext(true, null));

      expect(result).toContain('Live session target PID is unavailable');
      expect(nativeMocks.instances).toHaveLength(1);
      expect(nativeMocks.instances[0].start).not.toHaveBeenCalled();
    });
  });
});
