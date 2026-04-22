import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'node:net';
import { isPortInUse, findFreePort } from '../../src/utils/port.js';

describe('port utilities', () => {
  const servers: net.Server[] = [];

  afterEach(() => {
    for (const s of servers) {
      try { s.close(); } catch { /* */ }
    }
    servers.length = 0;
  });

  /** Start a TCP server on the given port and wait until it's listening. */
  function listenOn(port: number): Promise<net.Server> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      servers.push(server);
      server.listen(port, '127.0.0.1', () => resolve(server));
      server.on('error', reject);
    });
  }

  describe('isPortInUse()', () => {
    it('should return true when a server is listening on the port', async () => {
      const server = await listenOn(0);
      const port = (server.address() as net.AddressInfo).port;
      expect(await isPortInUse(port)).toBe(true);
    });

    it('should return false when nothing is listening on the port', async () => {
      // Get a free port, then close it — guaranteed nothing is listening
      const server = await listenOn(0);
      const port = (server.address() as net.AddressInfo).port;
      server.close();
      await new Promise<void>((r) => server.on('close', r));
      servers.length = 0;

      expect(await isPortInUse(port)).toBe(false);
    });
  });

  describe('findFreePort()', () => {
    it('should return a port number', async () => {
      const port = await findFreePort();
      expect(typeof port).toBe('number');
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThan(65536);
    });

    it('should return a port that is not currently in use', async () => {
      const port = await findFreePort();
      expect(await isPortInUse(port)).toBe(false);
    });

    it('should return different ports on successive calls', async () => {
      // Hold the first port open so the OS can't reassign it
      const port1 = await findFreePort();
      const server = await listenOn(port1);
      const port2 = await findFreePort();
      server.close();
      expect(port1).not.toBe(port2);
    });
  });

  describe('port conflict detection (integration)', () => {
    it('should detect when the default controller port is occupied', async () => {
      // Simulate another VS Code controller on port 9788
      const server = await listenOn(9788);
      expect(await isPortInUse(9788)).toBe(true);

      // A free port should be different
      const alt = await findFreePort();
      expect(alt).not.toBe(9788);
    });
  });
});
