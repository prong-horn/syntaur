import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { findAvailablePort, resolveDashboardMode } from '../commands/dashboard.js';

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
    expect(await findAvailablePort(4800, 2)).toBe(4800);
  });

  it('finds the next available port when the preferred port is in use', async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(4800, '127.0.0.1', () => resolve());
    });

    try {
      expect(await findAvailablePort(4800, 3)).toBe(4801);
    } finally {
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
  });
});
