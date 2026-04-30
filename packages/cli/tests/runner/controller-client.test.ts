import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { ControllerClient } from '../../src/runner/controller-client.js';

describe('ControllerClient', () => {
  let server: WebSocketServer;
  let serverSocket: WebSocket | undefined;
  let client: ControllerClient;
  const port = 19788; // Use a non-standard port for tests

  beforeEach(async () => {
    // Start a test WebSocket server
    server = new WebSocketServer({ port });
    await new Promise<void>((resolve) => server.on('listening', resolve));

    server.on('connection', (ws) => {
      serverSocket = ws;
      ws.on('message', (data) => {
        const request = JSON.parse(data.toString());
        // Auto-respond to requests
        switch (request.method) {
          case 'ping':
            ws.send(JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: { status: 'ok', timestamp: Date.now() },
            }));
            break;
          case 'executeCommand':
            ws.send(JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: { executed: true },
            }));
            break;
          case 'getState':
            ws.send(JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: {
                activeEditor: undefined,
                terminals: [],
                notifications: [],
              },
            }));
            break;
          case 'getNotifications':
            ws.send(JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: [{ message: 'Hello', severity: 'info' }],
            }));
            break;
          case 'getQuickInputState':
            ws.send(JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: { active: true, title: 'Pick', items: [{ id: 'item-1', label: 'Create', matchLabel: 'Create' }] },
            }));
            break;
          case 'selectQuickInputItem':
            ws.send(JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: { selected: request.params?.label, intercepted: true },
            }));
            break;
          case 'submitQuickInputText':
            ws.send(JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: { entered: request.params?.value, intercepted: true, accepted: true },
            }));
            break;
          case 'getProgressState':
            ws.send(JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: { active: [], history: [{ id: 'progress-1', title: 'Deploy', status: 'completed', createdAt: 1, updatedAt: 2, completedAt: 2 }] },
            }));
            break;
          case 'clickNotificationAction':
            ws.send(JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: { action: request.params?.action },
            }));
            break;
          case 'errorCommand':
            ws.send(JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              error: { code: -32603, message: 'Internal error' },
            }));
            break;
          case 'getOutputChannels':
            ws.send(JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: ['Output', 'Debug Console'],
            }));
            break;
          case 'getOutputChannel':
            ws.send(JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: { name: request.params?.name ?? '', content: 'channel content' },
            }));
            break;
          case 'listCommands':
            ws.send(JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: ['test.command1', 'test.command2'],
            }));
            break;
          case 'resetState':
            ws.send(JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: { status: 'reset' },
            }));
            break;
          case 'runExtensionHostScript':
            ws.send(JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: { ok: true, value: request.params?.script, timeoutMs: request.params?.timeoutMs, durationMs: 1 },
            }));
            break;
          default:
            // Don't auto-respond to unknown methods (used for testing pending rejection)
            break;
        }
      });
    });

    client = new ControllerClient(port);
  });

  afterEach(async () => {
    client.disconnect();
    serverSocket = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('connect()', () => {
    it('should connect to the WebSocket server', async () => {
      await client.connect();
      // No error thrown = success
    });

    it('should reject on connection failure', async () => {
      const badClient = new ControllerClient(19999); // No server on this port
      await expect(badClient.connect()).rejects.toThrow();
    });
  });

  describe('ping()', () => {
    it('should return ok status', async () => {
      await client.connect();
      const result = await client.ping() as { status: string };
      expect(result.status).toBe('ok');
    });
  });

  describe('executeCommand()', () => {
    it('should execute a command and return result', async () => {
      await client.connect();
      const result = await client.executeCommand('test.command') as { executed: boolean };
      expect(result.executed).toBe(true);
    });

    it('should honor custom request timeouts', async () => {
      const shortClient = new ControllerClient(port, 20);
      await shortClient.connect();

      await expect((shortClient as any).send('neverResponds')).rejects.toThrow('timed out');
      shortClient.disconnect();
    });
  });

  describe('getState()', () => {
    it('should return VS Code state', async () => {
      await client.connect();
      const state = await client.getState();
      expect(state).toBeDefined();
      expect(state.terminals).toEqual([]);
    });
  });

  describe('getNotifications()', () => {
    it('should return notifications', async () => {
      await client.connect();
      const notifications = await client.getNotifications();
      expect(notifications).toHaveLength(1);
      expect(notifications[0].message).toBe('Hello');
    });
  });

  describe('QuickInput helpers', () => {
    it('should return QuickInput state', async () => {
      await client.connect();
      const state = await client.getQuickInputState();
      expect(state.active).toBe(true);
      expect(state.items?.[0].label).toBe('Create');
    });

    it('should select a QuickInput item', async () => {
      await client.connect();
      const result = await client.selectQuickInputItem('Create');
      expect(result).toEqual({ selected: 'Create', intercepted: true });
    });

    it('should submit QuickInput text', async () => {
      await client.connect();
      const result = await client.submitQuickInputText('prod-rg');
      expect(result).toEqual({ entered: 'prod-rg', intercepted: true, accepted: true });
    });
  });

  describe('progress and notification helpers', () => {
    it('should return progress state', async () => {
      await client.connect();
      const progress = await client.getProgressState();
      expect(progress.history[0].title).toBe('Deploy');
    });

    it('should click a notification action', async () => {
      await client.connect();
      const result = await client.clickNotificationAction('Hello', 'Retry') as { action: string };
      expect(result.action).toBe('Retry');
    });
  });

  describe('getOutputChannels()', () => {
    it('should return channel names', async () => {
      await client.connect();
      const channels = await client.getOutputChannels();
      expect(channels).toContain('Output');
    });
  });

  describe('getOutputChannel()', () => {
    it('should return channel content', async () => {
      await client.connect();
      const ch = await client.getOutputChannel('Output');
      expect(ch.content).toBe('channel content');
    });
  });

  describe('listCommands()', () => {
    it('should return command list', async () => {
      await client.connect();
      const commands = await client.listCommands();
      expect(commands).toContain('test.command1');
    });
  });

  describe('resetState()', () => {
    it('should reset state', async () => {
      await client.connect();
      await client.resetState();
      // No error thrown
    });
  });

  describe('runExtensionHostScript()', () => {
    it('should send script and timeout parameters', async () => {
      await client.connect();
      const result = await client.runExtensionHostScript('return 42;', 25_000);

      expect(result).toEqual({ ok: true, value: 'return 42;', timeoutMs: 25_000, durationMs: 1 });
    });
  });

  describe('disconnect()', () => {
    it('should disconnect cleanly', async () => {
      await client.connect();
      client.disconnect();
      // Attempting operations after disconnect should fail
      await expect(client.ping()).rejects.toThrow('Not connected');
    });
  });

  describe('error handling', () => {
    it('should reject on JSON-RPC error response', async () => {
      await client.connect();
      // We need to send a request that triggers the error response
      await expect(
        (client as any).send('errorCommand')
      ).rejects.toThrow('Internal error');
    });

    it('should reject pending requests on close', async () => {
      await client.connect();

      // Start a request that won't get answered
      const pendingPromise = (client as any).send('slowCommand');

      // Force close the connection
      client.disconnect();

      await expect(pendingPromise).rejects.toThrow();
    });
  });
});
