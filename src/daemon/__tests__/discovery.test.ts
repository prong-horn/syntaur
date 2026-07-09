import { describe, it, expect, vi } from 'vitest';
import { SyntaurError } from '../../errors.js';
import {
  acquireDaemonLock,
  resolveDaemon,
  waitForDaemon,
  writeCurrentPointer,
  type DiscoveryDeps,
} from '../discovery.js';
import type { ProbeResult } from '../sockets.js';
import type { CurrentPointer, DaemonLock } from '../types.js';

/** In-memory single-slot lock file backing createExclusive/readFile/unlink. */
function fakeLockFs(initial: string | null = null) {
  let content = initial;
  return {
    createExclusive: (_p: string, data: string) => {
      if (content !== null) return false;
      content = data;
      return true;
    },
    readFile: (_p: string) => content,
    writeFile: (_p: string, data: string) => {
      content = data;
    },
    unlink: (_p: string) => {
      content = null;
    },
    get content() {
      return content;
    },
  };
}

const LOCK_PATH = '/tmp/syntaur-test/daemon.lock';

function lockJson(over: Partial<DaemonLock> = {}): string {
  return JSON.stringify({ pid: 4242, procStart: 'Wed Jul 9 12:00:00 2026', daemonId: 'd1', ...over });
}

describe('acquireDaemonLock', () => {
  it('acquires a free lock', () => {
    const fs = fakeLockFs(null);
    const ok = acquireDaemonLock({ pid: 1, procStart: 's', daemonId: 'me' }, LOCK_PATH, fs);
    expect(ok).toBe(true);
    expect(fs.content).toContain('"daemonId":"me"');
  });

  it('yields to a live owner and leaves the lock intact', () => {
    const fs = fakeLockFs(lockJson());
    const unlink = vi.fn();
    const ok = acquireDaemonLock({ pid: 1, procStart: 's', daemonId: 'me' }, LOCK_PATH, {
      ...fs,
      unlink,
      isPidAlive: () => true,
      pidStartedAt: () => 'Wed Jul 9 12:00:00 2026', // matches
    });
    expect(ok).toBe(false);
    expect(unlink).not.toHaveBeenCalled();
    expect(fs.content).toBe(lockJson());
  });

  it('recovers a stale lock held by a dead pid', () => {
    const fs = fakeLockFs(lockJson());
    const ok = acquireDaemonLock({ pid: 9, procStart: 's', daemonId: 'me' }, LOCK_PATH, {
      ...fs,
      isPidAlive: () => false,
    });
    expect(ok).toBe(true);
    expect(fs.content).toContain('"daemonId":"me"');
  });

  it('recovers a stale lock held by a recycled pid (start-time mismatch)', () => {
    const fs = fakeLockFs(lockJson({ procStart: 'OLD' }));
    const ok = acquireDaemonLock({ pid: 9, procStart: 's', daemonId: 'me' }, LOCK_PATH, {
      ...fs,
      isPidAlive: () => true,
      pidStartedAt: () => 'NEW', // different process now
    });
    expect(ok).toBe(true);
    expect(fs.content).toContain('"daemonId":"me"');
  });

  it('recovers from a corrupt lock file', () => {
    const fs = fakeLockFs('{ not json');
    const ok = acquireDaemonLock({ pid: 9, procStart: 's', daemonId: 'me' }, LOCK_PATH, fs);
    expect(ok).toBe(true);
  });
});

const POINTER_PATH = '/tmp/syntaur-test/current.json';
const pointer: CurrentPointer = {
  daemonId: 'd1',
  controlSock: '/tmp/syntaur-test/d1/control.sock',
  pid: 4242,
  procStart: 's',
};

describe('resolveDaemon', () => {
  it('returns the pointer when its control socket accepts', async () => {
    const deps: DiscoveryDeps = {
      readFile: () => JSON.stringify(pointer),
      probe: () => Promise.resolve('live'),
    };
    expect(await resolveDaemon(POINTER_PATH, deps)).toEqual(pointer);
  });

  it('returns null when the control socket refuses (dead daemon)', async () => {
    const deps: DiscoveryDeps = {
      readFile: () => JSON.stringify(pointer),
      probe: () => Promise.resolve('refused'),
    };
    expect(await resolveDaemon(POINTER_PATH, deps)).toBeNull();
  });

  it('falls back cleanly on a corrupt pointer', async () => {
    const deps: DiscoveryDeps = { readFile: () => '{ nope', probe: () => Promise.resolve('live') };
    expect(await resolveDaemon(POINTER_PATH, deps)).toBeNull();
  });

  it('returns null when the pointer is missing', async () => {
    const deps: DiscoveryDeps = { readFile: () => null };
    expect(await resolveDaemon(POINTER_PATH, deps)).toBeNull();
  });
});

describe('waitForDaemon', () => {
  it('polls until the winner control socket accepts, then returns it', async () => {
    const probeResults: ProbeResult[] = ['refused', 'refused', 'live'];
    let clock = 0;
    const deps: DiscoveryDeps = {
      readFile: () => JSON.stringify(pointer),
      probe: () => Promise.resolve(probeResults.shift() ?? 'refused'),
      now: () => clock,
      sleep: async () => {
        clock += 100;
      },
    };
    const got = await waitForDaemon(POINTER_PATH, deps, { timeoutMs: 5000, intervalMs: 100 });
    expect(got).toEqual(pointer);
  });

  it('throws an actionable SyntaurError on timeout', async () => {
    let clock = 0;
    const deps: DiscoveryDeps = {
      readFile: () => JSON.stringify(pointer),
      probe: () => Promise.resolve('refused'),
      now: () => clock,
      sleep: async () => {
        clock += 1000;
      },
    };
    await expect(
      waitForDaemon(POINTER_PATH, deps, { timeoutMs: 500, intervalMs: 100 }),
    ).rejects.toBeInstanceOf(SyntaurError);
  });
});

describe('writeCurrentPointer', () => {
  it('writes the pointer JSON', () => {
    const fs = fakeLockFs(null);
    writeCurrentPointer(pointer, POINTER_PATH, fs);
    expect(fs.content).toContain('"controlSock"');
  });
});
