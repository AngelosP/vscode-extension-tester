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
});
