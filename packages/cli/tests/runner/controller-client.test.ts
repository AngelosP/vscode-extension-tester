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
