import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { didUserSpecifyDashboardPort, findAvailablePort, resolveDashboardMode } from '../commands/dashboard.js';

async function createListeningServer(port: number = 0): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected server to listen on a TCP port.');
  }

  return { server, port: address.port };
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe('resolveDashboardMode', () => {
  it('uses bundled static UI by default', () => {
    expect(resolveDashboardMode({
      port: '4800',
      apiOnly: false,
      open: true,
    })).toBe('static');
  });

  it('uses dev mode when requested', () => {
    expect(resolveDashboardMode({
      port: '4800',
      dev: true,
      apiOnly: false,
      open: false,
    })).toBe('dev');
  });

  it('treats --api-only as server-only', () => {
    expect(resolveDashboardMode({
      port: '4800',
      apiOnly: true,
      open: false,
    })).toBe('server-only');
  });

  it('rejects conflicting dev and server-only flags', () => {
    expect(() => resolveDashboardMode({
      port: '4800',
      dev: true,
      serverOnly: true,
      apiOnly: false,
      open: false,
    })).toThrow('Use either --dev or --server-only');
  });

  it('finds the starting port when it is available', async () => {
    const { server, port } = await createListeningServer(0);
    await closeServer(server);
    expect(await findAvailablePort(port, 2)).toBe(port);
  });

  it('finds the next available port when the preferred port is in use', async () => {
    const { server, port } = await createListeningServer(0);

    try {
      const availablePort = await findAvailablePort(port, 10);
      expect(availablePort).not.toBeNull();
      expect(availablePort).not.toBe(port);
      expect(availablePort!).toBeGreaterThan(port);
    } finally {
      await closeServer(server);
    }
  });

  it('supports autoPort in the dashboard options shape', () => {
    expect(resolveDashboardMode({
      port: '4800',
      apiOnly: false,
      open: true,
      autoPort: true,
    })).toBe('static');
  });

  it('detects explicit dashboard port args', () => {
    expect(didUserSpecifyDashboardPort(['node', 'syntaur', 'dashboard'])).toBe(false);
    expect(didUserSpecifyDashboardPort(['node', 'syntaur', 'dashboard', '--port', '4801'])).toBe(true);
    expect(didUserSpecifyDashboardPort(['node', 'syntaur', 'dashboard', '--port=4801'])).toBe(true);
  });
});
