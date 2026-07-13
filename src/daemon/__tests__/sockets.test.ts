import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { connect, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyntaurError } from '../../errors.js';
import { bindUnixSocket, probeUnixSocket, type BindDeps, type ProbeResult } from '../sockets.js';

/**
 * Minimal net.Server stand-in whose listen() resolves or rejects (EADDRINUSE)
 * on the next microtask — matching the once('listening')/once('error') seam the
 * bind helper's internal listen() wrapper uses.
 */
function fakeServer(behavior: 'ok' | 'eaddrinuse'): Server {
  const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  const server = {
    once(evt: string, cb: (arg?: unknown) => void) {
      (handlers[evt] ||= []).push(cb);
      return server;
    },
    off(evt: string, cb: (arg?: unknown) => void) {
      handlers[evt] = (handlers[evt] || []).filter((h) => h !== cb);
      return server;
    },
    listen(_path: string) {
      queueMicrotask(() => {
        if (behavior === 'ok') {
          handlers['listening']?.forEach((h) => h());
        } else {
          const err = new Error('listen EADDRINUSE') as NodeJS.ErrnoException;
          err.code = 'EADDRINUSE';
          handlers['error']?.forEach((h) => h(err));
        }
      });
      return server;
    },
  } as unknown as Server;
  return server;
}

/** Build injected deps with a queue of server behaviors + a probe queue. */
function harness(opts: {
  pathExists: boolean;
  servers: ('ok' | 'eaddrinuse')[];
  probes: ProbeResult[];
}) {
  const unlink = vi.fn<(p: string) => void>();
  const probes = [...opts.probes];
  const servers = [...opts.servers];
  const createServer = vi.fn<(onConn: (s: Socket) => void) => Server>(() => {
    const next = servers.shift() ?? 'ok';
    return fakeServer(next);
  });
  const probe = vi.fn<(p: string) => Promise<ProbeResult>>(() =>
    Promise.resolve(probes.shift() ?? 'refused'),
  );
  const deps: BindDeps = {
    pathExists: () => opts.pathExists,
    unlink,
    createServer,
    probe,
  };
  return { deps, unlink, createServer, probe };
}

const noop = (): void => {};

describe('bindUnixSocket (injected deps)', () => {
  it('binds cleanly when the path does not exist', async () => {
    const { deps, unlink, createServer } = harness({
      pathExists: false,
      servers: ['ok'],
      probes: [],
    });
    await bindUnixSocket('/x/y.sock', noop, deps);
    expect(createServer).toHaveBeenCalledTimes(1);
    expect(unlink).not.toHaveBeenCalled();
  });

  it('unlinks a stale path (probe refused) then binds', async () => {
    const { deps, unlink, createServer } = harness({
      pathExists: true,
      servers: ['ok'],
      probes: ['refused'],
    });
    await bindUnixSocket('/x/y.sock', noop, deps);
    expect(unlink).toHaveBeenCalledWith('/x/y.sock');
    expect(unlink).toHaveBeenCalledTimes(1);
    expect(createServer).toHaveBeenCalledTimes(1);
  });

  it('refuses to steal a live socket (pre-bind), never unlinking', async () => {
    const { deps, unlink, createServer } = harness({
      pathExists: true,
      servers: [],
      probes: ['live'],
    });
    await expect(bindUnixSocket('/x/y.sock', noop, deps)).rejects.toBeInstanceOf(SyntaurError);
    expect(unlink).not.toHaveBeenCalled();
    expect(createServer).not.toHaveBeenCalled();
  });

  it('recovers from an EADDRINUSE race with a single unlink + one retry', async () => {
    const { deps, unlink, createServer } = harness({
      pathExists: false,
      servers: ['eaddrinuse', 'ok'],
      probes: ['refused'],
    });
    await bindUnixSocket('/x/y.sock', noop, deps);
    expect(createServer).toHaveBeenCalledTimes(2);
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it('fails as live owner on EADDRINUSE with a live probe, without unlinking', async () => {
    const { deps, unlink, createServer } = harness({
      pathExists: false,
      servers: ['eaddrinuse'],
      probes: ['live'],
    });
    await expect(bindUnixSocket('/x/y.sock', noop, deps)).rejects.toBeInstanceOf(SyntaurError);
    expect(unlink).not.toHaveBeenCalled();
    expect(createServer).toHaveBeenCalledTimes(1);
  });

  it('fails closed (pre-bind) on an indeterminate probe, never unlinking', async () => {
    const { deps, unlink, createServer } = harness({
      pathExists: true,
      servers: [],
      probes: ['error'],
    });
    await expect(bindUnixSocket('/x/y.sock', noop, deps)).rejects.toBeInstanceOf(SyntaurError);
    expect(unlink).not.toHaveBeenCalled();
    expect(createServer).not.toHaveBeenCalled();
  });

  it('fails closed on EADDRINUSE with an indeterminate probe, without unlinking', async () => {
    const { deps, unlink, createServer } = harness({
      pathExists: false,
      servers: ['eaddrinuse'],
      probes: ['error'],
    });
    await expect(bindUnixSocket('/x/y.sock', noop, deps)).rejects.toBeInstanceOf(SyntaurError);
    expect(unlink).not.toHaveBeenCalled();
    expect(createServer).toHaveBeenCalledTimes(1);
  });
});

describe('bindUnixSocket (real sockets)', () => {
  let dir: string;
  const open: Server[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'syntaur-sock-'));
  });
  afterEach(async () => {
    for (const s of open.splice(0)) {
      await new Promise<void>((r) => s.close(() => r()));
    }
    await rm(dir, { recursive: true, force: true });
  });

  it('binds, accepts a connection, and rejects a second live binder', async () => {
    const path = join(dir, 'a.sock');
    let connected = false;
    const server = await bindUnixSocket(path, () => {
      connected = true;
    });
    open.push(server);
    expect(existsSync(path)).toBe(true);

    await new Promise<void>((resolvePromise, reject) => {
      const c = connect(path, () => {
        c.end();
        resolvePromise();
      });
      c.once('error', reject);
    });
    // give the accept handler a tick
    await new Promise((r) => setTimeout(r, 20));
    expect(connected).toBe(true);

    await expect(bindUnixSocket(path, noop)).rejects.toBeInstanceOf(SyntaurError);
  });

  it('rebinds the same path after a clean shutdown', async () => {
    const path = join(dir, 'b.sock');
    const first = await bindUnixSocket(path, noop);
    await new Promise<void>((r) => first.close(() => r()));
    // Node unlinks the socket file on a clean close.
    expect(existsSync(path)).toBe(false);

    // The freed path binds again and accepts connections.
    let connected = false;
    const second = await bindUnixSocket(path, () => {
      connected = true;
    });
    open.push(second);
    expect(existsSync(path)).toBe(true);
    await new Promise<void>((resolvePromise, reject) => {
      const c = connect(path, () => {
        c.end();
        resolvePromise();
      });
      c.once('error', reject);
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(connected).toBe(true);
  });
});

describe('probeUnixSocket', () => {
  it('reports refused for a non-existent path', async () => {
    expect(await probeUnixSocket('/tmp/syntaur-does-not-exist.sock')).toBe('refused');
  });
});
