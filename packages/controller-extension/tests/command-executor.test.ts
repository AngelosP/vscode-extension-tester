import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock vscode module
vi.mock('vscode', () => ({
  commands: {
    executeCommand: vi.fn().mockResolvedValue(undefined),
    getCommands: vi.fn().mockResolvedValue(['test.command', 'editor.action.copy', 'workbench.action.openSettings']),
  },
}));

import { CommandExecutor } from '../src/command-executor.js';

describe('CommandExecutor', () => {
  let executor: CommandExecutor;
  let vscode: any;

  beforeEach(async () => {
    executor = new CommandExecutor();
    vscode = await import('vscode');
    vi.clearAllMocks();
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
  });

  describe('listCommands()', () => {
    it('should return available commands', async () => {
      const commands = await executor.listCommands();

      expect(commands).toContain('test.command');
      expect(commands).toContain('editor.action.copy');
      expect(commands.length).toBeGreaterThan(0);
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
