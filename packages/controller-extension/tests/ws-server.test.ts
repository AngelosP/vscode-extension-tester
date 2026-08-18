import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  commands: {
    executeCommand: vi.fn().mockResolvedValue(undefined),
    getCommands: vi.fn().mockResolvedValue([]),
  },
}));

import { WSServer } from '../src/ws-server.js';

function createServices() {
  return {
    commandExecutor: {
      closeAllEditors: vi.fn().mockResolvedValue({ closed: true, discarded: [] }),
    },
    uiInterceptor: {
      clearQuickInput: vi.fn(),
    },
    stateReader: {
      clearNotifications: vi.fn(),
      clearProgress: vi.fn(),
    },
    outputMonitor: {},
    authHandler: {},
  };
}

describe('WSServer resetState', () => {
  let services: ReturnType<typeof createServices>;
  let server: WSServer;

  beforeEach(() => {
    services = createServices();
    server = new WSServer(0, services as never);
  });

  it.each([
    ['missing', undefined, false],
    ['false', { discardDirty: false }, false],
    ['true', { discardDirty: true }, true],
  ])('maps %s discardDirty to %s', async (_label, params, expected) => {
    await (server as any).dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'resetState',
      params,
    });

    expect(services.commandExecutor.closeAllEditors).toHaveBeenCalledWith({ discardDirty: expected });
  });
});
