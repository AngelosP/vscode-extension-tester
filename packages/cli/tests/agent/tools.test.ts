import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS } from '../../src/agent/tools.js';

describe('tools', () => {
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
      expect(names).toContain('reset_live_session');
      expect(names).toContain('end_live_session');
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
});
