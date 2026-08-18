import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock vscode module
vi.mock('vscode', () => {
  class MockTabInputCustom {
    constructor(readonly uri: unknown, readonly viewType: string) {}
  }
  return {
  commands: {
    executeCommand: vi.fn().mockResolvedValue(undefined),
    getCommands: vi.fn().mockResolvedValue(['test.command', 'editor.action.copy', 'workbench.action.openSettings']),
  },
  window: {
    tabGroups: { all: [] },
  },
  TabInputCustom: MockTabInputCustom,
  };
});

import { CommandExecutor } from '../src/command-executor.js';

describe('CommandExecutor', () => {
  let executor: CommandExecutor;
  let vscode: any;

  beforeEach(async () => {
    executor = new CommandExecutor();
    vscode = await import('vscode');
    vi.clearAllMocks();
    vscode.window.tabGroups.all = [];
  });

  describe('execute()', () => {
    it('should execute a command by ID', async () => {
      vscode.commands.executeCommand.mockResolvedValue('result');

      const result = await executor.execute('test.command');

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('test.command');
      expect(result).toBe('result');
    });

    it('should pass arguments to the command', async () => {
      vscode.commands.executeCommand.mockResolvedValue(undefined);

      await executor.execute('test.command', ['arg1', 'arg2']);

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('test.command', 'arg1', 'arg2');
    });

    it('should return { executed: true } when command returns undefined', async () => {
      vscode.commands.executeCommand.mockResolvedValue(undefined);

      const result = await executor.execute('test.command');

      expect(result).toEqual({ executed: true });
    });

    it('should handle empty args array', async () => {
      vscode.commands.executeCommand.mockResolvedValue('ok');

      const result = await executor.execute('test.command', []);

      expect(result).toBe('ok');
    });

    it('should propagate errors from executeCommand', async () => {
      vscode.commands.executeCommand.mockRejectedValue(new Error('Command failed'));

      await expect(executor.execute('bad.command')).rejects.toThrow('Command failed');
    });

    it('rejects closeAllEditors before mutating dirty custom editors', async () => {
      const uri = { toString: () => 'file:///dirty.kqlx' };
      const tab = {
        label: 'dirty.kqlx', isDirty: true, isActive: true,
        input: new vscode.TabInputCustom(uri, 'kusto.kqlxEditor'),
      };
      const group = { viewColumn: 1, isActive: true, tabs: [tab] };
      vscode.window.tabGroups.all = [group];
      await expect(executor.execute('workbench.action.closeAllEditors')).rejects.toThrow(
        'Dirty editors prevent closeAllEditors: dirty.kqlx',
      );

      expect(tab.isDirty).toBe(true);
      expect(group.tabs).toContain(tab);
      expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });

    it('reset cleanup discards dirty editors without failing', async () => {
      const tab = { label: 'dirty.txt', isDirty: true, isActive: true, input: {} };
      const group = { viewColumn: 1, isActive: true, tabs: [tab] };
      vscode.window.tabGroups.all = [group];
      vscode.commands.executeCommand.mockImplementation(async (command: string) => {
        if (command === 'workbench.action.focusActiveEditorGroup') {
          group.isActive = true;
          tab.isActive = true;
        }
        if (command === 'workbench.action.revertAndCloseActiveEditor') {
          tab.isDirty = false;
          group.tabs.splice(group.tabs.indexOf(tab), 1);
        }
        return undefined;
      });

      await expect(executor.closeAllEditors({ discardDirty: true })).resolves.toEqual({
        closed: true,
        discarded: ['dirty.txt'],
      });
    });

    it('verifies a dirty custom editor is active before discarding it', async () => {
      const uri = { toString: () => 'file:///dirty.kqlx' };
      const tab = {
        label: 'dirty.kqlx', isDirty: true, isActive: false,
        input: new vscode.TabInputCustom(uri, 'kusto.kqlxEditor'),
      };
      const group = { viewColumn: 2, isActive: false, tabs: [tab] };
      vscode.window.tabGroups.all = [group];
      vscode.commands.executeCommand.mockImplementation(async (command: string) => {
        if (command === 'vscode.openWith') {
          group.isActive = true;
          tab.isActive = true;
        }
        if (command === 'workbench.action.revertAndCloseActiveEditor') {
          expect(group.isActive).toBe(true);
          expect(tab.isActive).toBe(true);
          tab.isDirty = false;
          group.tabs.splice(group.tabs.indexOf(tab), 1);
        }
        return undefined;
      });

      await expect(executor.closeAllEditors({ discardDirty: true })).resolves.toEqual({
        closed: true,
        discarded: ['dirty.kqlx'],
      });
    });

    it('reset cleanup recovers when close first blocks and then exposes a dirty editor', async () => {
      vi.useFakeTimers();
      try {
        const tab = { label: 'late-dirty.txt', isDirty: false, isActive: true, input: {} };
        const group = { viewColumn: 1, isActive: true, tabs: [tab] };
        vscode.window.tabGroups.all = [group];
        let closeCalls = 0;
        vscode.commands.executeCommand.mockImplementation((command: string) => {
          if (command === 'workbench.action.closeAllEditors') {
            closeCalls += 1;
            if (closeCalls === 1) {
              tab.isDirty = true;
              return new Promise<void>(() => {});
            }
          }
          if (command === 'workbench.action.revertAndCloseActiveEditor') {
            tab.isDirty = false;
            group.tabs.splice(group.tabs.indexOf(tab), 1);
          }
          return Promise.resolve(undefined);
        });

        const cleanup = executor.closeAllEditors({ discardDirty: true });
        await vi.advanceTimersByTimeAsync(5_000);

        await expect(cleanup).resolves.toEqual({ closed: true, discarded: ['late-dirty.txt'] });
        expect(closeCalls).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('listCommands()', () => {
    it('should return available commands', async () => {
      const commands = await executor.listCommands();

      expect(commands).toContain('test.command');
      expect(commands).toContain('editor.action.copy');
      expect(commands.length).toBeGreaterThan(0);
    });
  });

  describe('runExtensionHostScript()', () => {
    it('should run a script with access to vscode and return JSON-safe values', async () => {
      const result = await executor.runExtensionHostScript('return { commandCount: (await vscode.commands.getCommands(true)).length };');

      expect(result.ok).toBe(true);
      expect(result.value).toEqual({ commandCount: 3 });
    });

    it('should return structured script errors', async () => {
      const result = await executor.runExtensionHostScript('throw new Error("script failed");');

      expect(result.ok).toBe(false);
      expect(result.error?.message).toBe('script failed');
      expect(result.error?.name).toBe('Error');
    });

    it('should return a timeout error for unresolved async scripts', async () => {
      vi.useFakeTimers();
      try {
        const resultPromise = executor.runExtensionHostScript('await new Promise(() => {});', 25);
        await vi.advanceTimersByTimeAsync(25);
        const result = await resultPromise;

        expect(result.ok).toBe(false);
        expect(result.error?.message).toContain('timed out after 25ms');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('start()', () => {
    it('should call executeCommand and return immediately', () => {
      let resolveCommand!: () => void;
      vscode.commands.executeCommand.mockReturnValue(
        new Promise<void>((resolve) => { resolveCommand = resolve; })
      );

      const result = executor.start('test.slowCommand');

      // Returns immediately, before the command resolves
      expect(result).toEqual({ started: true, commandId: 'test.slowCommand' });
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('test.slowCommand');

      // Clean up the pending promise
      resolveCommand();
    });

    it('should pass arguments to the command', () => {
      vscode.commands.executeCommand.mockResolvedValue(undefined);

      const result = executor.start('test.command', ['arg1', 'arg2']);

      expect(result).toEqual({ started: true, commandId: 'test.command' });
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('test.command', 'arg1', 'arg2');
    });

    it('should not throw when the command rejects', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vscode.commands.executeCommand.mockRejectedValue(new Error('Command failed'));

      // start() itself should not throw
      const result = executor.start('bad.command');
      expect(result).toEqual({ started: true, commandId: 'bad.command' });

      // Let the rejection handler run
      await vi.waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith(
          '[vscode-ext-test] Fire-and-forget command failed:',
          'bad.command',
          expect.any(Error),
        );
      });

      consoleSpy.mockRestore();
    });
  });
});
