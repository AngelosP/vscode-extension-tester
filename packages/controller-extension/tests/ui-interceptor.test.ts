import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock vscode module
vi.mock('vscode', () => ({
  commands: {
    executeCommand: vi.fn().mockResolvedValue(undefined),
  },
  window: {
    showInputBox: vi.fn().mockImplementation(() => new Promise(() => {})),
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
    it('should intercept showInputBox and resolve with provided value', async () => {
      // Underlying showInputBox hangs (simulates open InputBox waiting for input)
      vscode.window.showInputBox.mockImplementation(() => new Promise(() => {}));

      const disposables = interceptor.register();

      // Simulate the extension under test calling showInputBox
      const extensionPromise = vscode.window.showInputBox({ prompt: 'Enter URL' });

      // Respond programmatically
      const result = await interceptor.respondToInputBox('https://example.com');

      expect(result).toEqual({ entered: 'https://example.com', intercepted: true });

      // The extension's await showInputBox() should have resolved with our value
      const extensionResult = await extensionPromise;
      expect(extensionResult).toBe('https://example.com');

      // closeQuickOpen should have been called to dismiss the visual InputBox
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'workbench.action.closeQuickOpen'
      );

      disposables.forEach((d: any) => d.dispose());
    });

    it('should return intercepted:false when no InputBox was intercepted', async () => {
      // No register() call — no monkey-patch installed
      const result = await interceptor.respondToInputBox('hello world');

      expect(result).toEqual({ entered: 'hello world', intercepted: false });

      // Should NOT have called any commands (caller will use CDP instead)
      expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });

    it('should track lastInputBoxPrompt from intercepted call', async () => {
      vscode.window.showInputBox.mockImplementation(() => new Promise(() => {}));

      const disposables = interceptor.register();
      vscode.window.showInputBox({ prompt: 'Enter URL', placeHolder: 'https://...' });

      expect(interceptor.getLastInputBoxPrompt()).toBe('Enter URL');

      // Clean up (resolve pending to avoid hanging)
      await interceptor.respondToInputBox('test');
      disposables.forEach((d: any) => d.dispose());
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
      expect(disposables.length).toBeGreaterThan(0);
      // Clean up
      disposables.forEach((d: any) => d.dispose());
    });

    it('should monkey-patch vscode.window.showInputBox', () => {
      const originalFn = vscode.window.showInputBox;
      const disposables = interceptor.register();

      // showInputBox should now be a different function (the wrapper)
      expect(vscode.window.showInputBox).not.toBe(originalFn);

      // Disposing should restore the original
      disposables.forEach((d: any) => d.dispose());
      expect(vscode.window.showInputBox).toBe(originalFn);
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
