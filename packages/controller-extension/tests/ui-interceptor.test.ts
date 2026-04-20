import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock vscode module
vi.mock('vscode', () => ({
  commands: {
    executeCommand: vi.fn().mockResolvedValue(undefined),
  },
}));

import { UIInterceptor } from '../src/ui-interceptor.js';

describe('UIInterceptor', () => {
  let interceptor: UIInterceptor;
  let vscode: any;

  beforeEach(async () => {
    interceptor = new UIInterceptor();
    vscode = await import('vscode');
    vi.clearAllMocks();
  });

  describe('respondToQuickPick()', () => {
    it('should type the label and accept', async () => {
      const result = await interceptor.respondToQuickPick('TypeScript');

      expect(result).toEqual({ selected: 'TypeScript' });
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'workbench.action.quickOpenSelectNext'
      );
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('type', { text: 'TypeScript' });
    });

    it('should return the selected label', async () => {
      const result = await interceptor.respondToQuickPick('My Item');

      expect(result.selected).toBe('My Item');
    });
  });

  describe('respondToInputBox()', () => {
    it('should focus QuickInput, type the value, and accept', async () => {
      const result = await interceptor.respondToInputBox('hello world');

      expect(result).toEqual({ entered: 'hello world' });

      // Verify call order: quickOpenSelectNext first, then type, then accept
      const calls = vscode.commands.executeCommand.mock.calls;
      const focusIdx = calls.findIndex((c: any[]) => c[0] === 'workbench.action.quickOpenSelectNext');
      const typeIdx = calls.findIndex((c: any[]) => c[0] === 'type');
      const acceptIdx = calls.findIndex((c: any[]) => c[0] === 'workbench.action.acceptSelectedQuickOpenItem');

      expect(focusIdx).toBeGreaterThanOrEqual(0);
      expect(typeIdx).toBeGreaterThan(focusIdx);
      expect(acceptIdx).toBeGreaterThan(typeIdx);
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('type', { text: 'hello world' });
    });
  });

  describe('respondToDialog()', () => {
    it('should resolve pending dialog', async () => {
      // Set up a pending dialog
      const dialogPromise = interceptor.createDialogPromise();

      // Respond to it
      const responsePromise = interceptor.respondToDialog('OK');
      const dialogResult = await dialogPromise;

      expect(dialogResult).toBe('OK');
      const response = await responsePromise;
      expect(response).toEqual({ clicked: 'OK' });
    });

    it('should throw when no dialog is pending', async () => {
      await expect(interceptor.respondToDialog('OK')).rejects.toThrow('No dialog is currently pending');
    });
  });

  describe('createDialogPromise()', () => {
    it('should create a promise that resolves when responded to', async () => {
      const promise = interceptor.createDialogPromise();

      // Don't await yet - respond to it
      setTimeout(() => {
        interceptor.respondToDialog('Cancel');
      }, 10);

      const result = await promise;
      expect(result).toBe('Cancel');
    });
  });

  describe('register()', () => {
    it('should return an array of disposables', () => {
      const disposables = interceptor.register();
      expect(Array.isArray(disposables)).toBe(true);
    });
  });

  describe('getLastQuickPickItems()', () => {
    it('should return empty array initially', () => {
      expect(interceptor.getLastQuickPickItems()).toEqual([]);
    });
  });

  describe('getLastInputBoxPrompt()', () => {
    it('should return empty string initially', () => {
      expect(interceptor.getLastInputBoxPrompt()).toBe('');
    });
  });
});
