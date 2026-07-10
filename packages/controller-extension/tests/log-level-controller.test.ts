import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  commands: {
    executeCommand: vi.fn(),
    getCommands: vi.fn(),
  },
}));

import * as vscode from 'vscode';
import { LogLevelController, parseLogLevel } from '../src/log-level-controller.js';

describe('LogLevelController', () => {
  const executeCommand = vi.mocked(vscode.commands.executeCommand);
  const getCommands = vi.mocked(vscode.commands.getCommands);
  let controller: LogLevelController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new LogLevelController();
  });

  it('sets and observes the global log level', async () => {
    executeCommand.mockImplementation(async (command) => {
      if (command === '_extensionTests.getLogLevel') return 'trace';
      return undefined;
    });

    await expect(controller.setLogLevel('Trace')).resolves.toEqual({
      status: 'ok',
      scope: 'global',
      actualLevel: 'Trace',
    });
    expect(executeCommand).toHaveBeenNthCalledWith(1, '_extensionTests.setLogLevel', 'trace');
    expect(executeCommand).toHaveBeenNthCalledWith(2, '_extensionTests.getLogLevel');
  });

  it('rejects a global request when VS Code reports a different level', async () => {
    executeCommand.mockImplementation(async (command) => {
      if (command === '_extensionTests.getLogLevel') return 'info';
      return undefined;
    });

    await expect(controller.setLogLevel('Trace')).rejects.toThrow('actual level is Info');
  });

  it('sets a named LogOutputChannel through its generated workbench command', async () => {
    getCommands.mockResolvedValue([
      'workbench.action.output.show.angelos-petropoulos.vscode-kusto-workbench.Kusto Workbench.log',
    ]);
    executeCommand.mockResolvedValue(undefined);

    await expect(controller.setLogLevel('Trace', 'Kusto Workbench')).resolves.toMatchObject({
      status: 'applied',
      scope: 'channel',
      channel: 'Kusto Workbench',
    });
    expect(executeCommand).toHaveBeenNthCalledWith(
      1,
      'workbench.action.output.show.angelos-petropoulos.vscode-kusto-workbench.Kusto Workbench.log',
    );
    expect(executeCommand).toHaveBeenNthCalledWith(2, 'workbench.action.output.activeOutputLogLevel.1');
  });

  it.each([
    ['Off', 0],
    ['Trace', 1],
    ['Debug', 2],
    ['Info', 3],
    ['Warning', 4],
    ['Error', 5],
  ] as const)('maps %s to the VS Code LogLevel command suffix %i', async (level, suffix) => {
    getCommands.mockResolvedValue([
      'workbench.action.output.show.publisher.extension.Test Channel.log',
    ]);
    executeCommand.mockResolvedValue(undefined);

    await controller.setLogLevel(level, 'Test Channel');

    expect(executeCommand).toHaveBeenLastCalledWith(`workbench.action.output.activeOutputLogLevel.${suffix}`);
  });

  it('waits for asynchronous LogOutputChannel registration', async () => {
    getCommands
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        'workbench.action.output.show.angelos-petropoulos.vscode-kusto-workbench.Kusto Workbench.log',
      ]);
    executeCommand.mockResolvedValue(undefined);

    await expect(controller.setLogLevel('Trace', 'Kusto Workbench')).resolves.toMatchObject({
      status: 'applied',
      channel: 'Kusto Workbench',
    });

    expect(getCommands).toHaveBeenCalledTimes(2);
  });

  it('fails clearly when the named channel is not registered', async () => {
    vi.useFakeTimers();
    getCommands.mockResolvedValue([]);

    try {
      const result = controller.setLogLevel('Debug', 'Missing');
      const assertion = expect(result).rejects.toThrow('was not found within 10000ms');
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('normalizes supported level names and aliases', () => {
    expect(parseLogLevel('warning')).toBe('Warning');
    expect(parseLogLevel('WARN')).toBe('Warning');
    expect(() => parseLogLevel('verbose')).toThrow('Unsupported log level');
  });
});
