import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
  QuickPickItemKind: { Separator: -1 },
  InputBoxValidationSeverity: { Info: 1, Warning: 2, Error: 3 },
  commands: {
    executeCommand: vi.fn().mockResolvedValue(undefined),
  },
  window: {
    showQuickPick: vi.fn().mockImplementation(() => new Promise(() => {})),
    createQuickPick: vi.fn(),
    showInputBox: vi.fn().mockImplementation(() => new Promise(() => {})),
    createInputBox: vi.fn(),
  },
}));

import { UIInterceptor } from '../src/ui-interceptor.js';

function createEmitter<T>() {
  const listeners: Array<(value: T) => void> = [];
  return {
    event: (listener: (value: T) => void) => {
      listeners.push(listener);
      return { dispose: vi.fn() };
    },
    fire: (value: T) => {
      for (const listener of listeners) listener(value);
    },
  };
}

function createFakeQuickPick() {
  const valueEmitter = createEmitter<string>();
  const activeEmitter = createEmitter<any[]>();
  const selectionEmitter = createEmitter<any[]>();
  const hideEmitter = createEmitter<void>();
  const quickPick = {
    title: '',
    placeholder: '',
    value: '',
    busy: false,
    enabled: true,
    canSelectMany: false,
    items: [] as any[],
    activeItems: [] as any[],
    selectedItems: [] as any[],
    onDidChangeValue: valueEmitter.event,
    onDidChangeActive: activeEmitter.event,
    onDidChangeSelection: selectionEmitter.event,
    onDidHide: hideEmitter.event,
    show: vi.fn(),
    hide: vi.fn(() => hideEmitter.fire(undefined)),
    dispose: vi.fn(),
    fireValue: valueEmitter.fire,
    fireActive: activeEmitter.fire,
    fireSelection: selectionEmitter.fire,
  };
  return quickPick;
}

function createFakeInputBox(onValueChange?: (value: string, inputBox: any) => void) {
  const valueEmitter = createEmitter<string>();
  const hideEmitter = createEmitter<void>();
  let currentValue = '';
  const inputBox: any = {
    title: '',
    placeholder: '',
    prompt: '',
    validationMessage: undefined,
    busy: false,
    enabled: true,
    onDidChangeValue: valueEmitter.event,
    onDidHide: hideEmitter.event,
    show: vi.fn(),
    hide: vi.fn(() => hideEmitter.fire(undefined)),
    dispose: vi.fn(),
  };
  Object.defineProperty(inputBox, 'value', {
    get: () => currentValue,
    set: (value: string) => {
      currentValue = value;
      onValueChange?.(value, inputBox);
      valueEmitter.fire(value);
    },
  });
  return inputBox;
}

describe('UIInterceptor', () => {
  let interceptor: UIInterceptor;
  let vscode: any;

  beforeEach(async () => {
    interceptor = new UIInterceptor();
    vscode = await import('vscode');
    vi.clearAllMocks();
    vscode.window.showQuickPick.mockImplementation(() => new Promise(() => {}));
    vscode.window.showInputBox.mockImplementation(() => new Promise(() => {}));
  });

  describe('showQuickPick interception', () => {
    it('captures items and resolves with the original object item', async () => {
      const disposables = interceptor.register();
      const item = { label: '$(zap) Deploy', description: 'Azure', detail: 'Create resources' };

      const promise = (vscode.window.showQuickPick as any)([item], { title: 'Pick action' });
      await Promise.resolve();

      expect(interceptor.getQuickInputState()).toMatchObject({
        active: true,
        kind: 'quickPick',
        title: 'Pick action',
      });
      expect(interceptor.getQuickInputState().items?.[0]).toMatchObject({
        label: '$(zap) Deploy',
        matchLabel: 'Deploy',
      });

      const result = await interceptor.selectQuickInputItem('Deploy');
      await expect(promise).resolves.toBe(item);
      expect(result).toEqual({ selected: '$(zap) Deploy', intercepted: true });
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.closeQuickOpen');

      disposables.forEach((d: any) => d.dispose());
    });

    it('invokes showQuickPick onDidSelectItem before resolving', async () => {
      const disposables = interceptor.register();
      const item = { label: 'Deploy' };
      const onDidSelectItem = vi.fn();

      const promise = (vscode.window.showQuickPick as any)([item], { onDidSelectItem });
      await Promise.resolve();

      await interceptor.selectQuickInputItem('Deploy');

      expect(onDidSelectItem).toHaveBeenCalledWith(item);
      await expect(promise).resolves.toBe(item);

      disposables.forEach((d: any) => d.dispose());
    });

    it('rejects separator selection', async () => {
      const disposables = interceptor.register();
      (vscode.window.showQuickPick as any)([
        { label: 'Group', kind: vscode.QuickPickItemKind.Separator },
      ]);
      await Promise.resolve();

      await expect(interceptor.selectQuickInputItem('Group')).rejects.toThrow('separator');
      disposables.forEach((d: any) => d.dispose());
    });

    it('falls back to legacy command selection when no QuickPick is active', async () => {
      const result = await interceptor.respondToQuickPick('TypeScript');

      expect(result).toEqual({ selected: 'TypeScript' });
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.quickOpenSelectNext');
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('type', { text: 'TypeScript' });
    });

    it('falls back to legacy command selection when the captured model is stale', async () => {
      const disposables = interceptor.register();
      (vscode.window.showQuickPick as any)([{ label: 'Only visible later' }]);
      await Promise.resolve();

      const result = await interceptor.respondToQuickPick('Create new resource group');

      expect(result).toEqual({ selected: 'Create new resource group' });
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.quickOpenSelectNext');
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('type', { text: 'Create new resource group' });

      disposables.forEach((d: any) => d.dispose());
    });
  });

  describe('createQuickPick interception', () => {
    it('tracks dynamic items and sets the real selectedItems before accepting', async () => {
      const fakeQuickPick = createFakeQuickPick();
      vscode.window.createQuickPick.mockReturnValue(fakeQuickPick);
      const disposables = interceptor.register();

      const quickPick = vscode.window.createQuickPick();
      const item = { label: 'Create new resource group' };
      quickPick.title = 'Resource group';
      quickPick.items = [item];
      quickPick.show();

      expect(interceptor.getQuickInputState()).toMatchObject({ title: 'Resource group' });
      expect(interceptor.getQuickInputState().items?.[0].label).toBe('Create new resource group');

      await interceptor.selectQuickInputItem('Create new resource group');

      expect(fakeQuickPick.activeItems).toEqual([item]);
      expect(fakeQuickPick.selectedItems).toEqual([item]);
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.acceptSelectedQuickOpenItem');

      disposables.forEach((d: any) => d.dispose());
    });
  });

  describe('showInputBox interception', () => {
    it('waits for validation before resolving the original promise', async () => {
      const disposables = interceptor.register();
      const promise = vscode.window.showInputBox({
        prompt: 'Name',
        validateInput: (value: string) => value ? undefined : 'Name is required',
      });

      expect(await interceptor.submitQuickInputText('')).toEqual({
        entered: '',
        intercepted: true,
        accepted: false,
        validationMessage: 'Name is required',
      });

      expect(await interceptor.submitQuickInputText('prod-rg')).toEqual({
        entered: 'prod-rg',
        intercepted: true,
        accepted: true,
      });
      await expect(promise).resolves.toBe('prod-rg');
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.closeQuickOpen');

      disposables.forEach((d: any) => d.dispose());
    });

    it('returns intercepted:false when no InputBox is active', async () => {
      const result = await interceptor.submitQuickInputText('hello world');
      expect(result).toEqual({ entered: 'hello world', intercepted: false });
    });

    it('allows warning validation messages', async () => {
      const disposables = interceptor.register();
      const promise = vscode.window.showInputBox({
        validateInput: () => ({ message: 'Looks unusual', severity: vscode.InputBoxValidationSeverity.Warning }),
      });

      expect(await interceptor.submitQuickInputText('prod-rg')).toEqual({
        entered: 'prod-rg',
        intercepted: true,
        accepted: true,
      });
      await expect(promise).resolves.toBe('prod-rg');

      disposables.forEach((d: any) => d.dispose());
    });
  });

  describe('createInputBox interception', () => {
    it('waits for async validation before accepting', async () => {
      const fakeInputBox = createFakeInputBox((value, inputBox) => {
        setTimeout(() => {
          inputBox.validationMessage = value === 'bad' ? 'Still invalid' : undefined;
        }, 75);
      });
      vscode.window.createInputBox.mockReturnValue(fakeInputBox);
      const disposables = interceptor.register();

      const inputBox = vscode.window.createInputBox();
      inputBox.show();

      expect(await interceptor.submitQuickInputText('bad')).toEqual({
        entered: 'bad',
        intercepted: true,
        accepted: false,
        validationMessage: 'Still invalid',
      });

      expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('workbench.action.acceptSelectedQuickOpenItem');

      disposables.forEach((d: any) => d.dispose());
    });
  });

  describe('dialogs', () => {
    it('resolves pending dialog', async () => {
      const dialogPromise = interceptor.createDialogPromise();
      const responsePromise = interceptor.respondToDialog('OK');
      await expect(dialogPromise).resolves.toBe('OK');
      await expect(responsePromise).resolves.toEqual({ clicked: 'OK' });
    });
  });

  describe('initial state', () => {
    it('returns an inactive QuickInput state initially', () => {
      expect(interceptor.getQuickInputState()).toEqual({ active: false });
      expect(interceptor.getLastQuickPickItems()).toEqual([]);
      expect(interceptor.getLastInputBoxPrompt()).toBe('');
    });
  });
});
