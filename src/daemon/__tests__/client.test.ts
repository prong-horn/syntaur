import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SyntaurError } from '../../errors.js';
import { ensureDaemon, sendRequest, type ClientDeps } from '../client.js';
import { bindUnixSocket } from '../sockets.js';
import { createLineDecoder, encodeFrame } from '../protocol.js';
import type { DaemonSpawnFn } from '../supervisor.js';
import type { ProbeResult } from '../sockets.js';
import type { CurrentPointer } from '../types.js';

const pointer: CurrentPointer = {
  daemonId: 'd1',
  controlSock: '/tmp/syntaur-test/d1/control.sock',
  pid: 4242,
  procStart: 's',
};

function fakeSpawn() {
  return vi.fn<DaemonSpawnFn>(() => ({ pid: 1, unref: vi.fn() }) as unknown as ChildProcess);
}

const baseDarwin = (over: ClientDeps): ClientDeps => ({
  readFile: () => JSON.stringify(pointer),
  platform: 'darwin',
  uid: 501,
  execPath: '/usr/bin/node',
  cliEntryPath: '/opt/syntaur/dist/index.js',
  now: () => 0,
  sleep: async () => {},
  ...over,
});

describe('ensureDaemon', () => {
  it('returns the resolved daemon without spawning when already live', async () => {
    const spawn = fakeSpawn();
    const p = await ensureDaemon({ readFile: () => JSON.stringify(pointer), probe: async () => 'live', spawn });
    expect(p).toEqual(pointer);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns then returns once the control socket accepts', async () => {
    const probes: ProbeResult[] = ['refused', 'refused', 'live'];
    const spawn = fakeSpawn();
    let clock = 0;
    const p = await ensureDaemon({
      readFile: () => JSON.stringify(pointer),
      probe: async () => probes.shift() ?? 'refused',
      spawn,
      platform: 'linux',
      now: () => clock,
      sleep: async () => {
        clock += 100;
      },
      waitTimeoutMs: 5000,
      waitIntervalMs: 100,
    });
    expect(spawn).toHaveBeenCalledOnce();
    expect(p).toEqual(pointer);
  });

  it('throws a SyntaurError when the daemon never comes up', async () => {
    const spawn = fakeSpawn();
    let clock = 0;
    await expect(
      ensureDaemon({
        readFile: () => JSON.stringify(pointer),
        probe: async () => 'refused',
        spawn,
        platform: 'linux',
        now: () => clock,
        sleep: async () => {
          clock += 1000;
        },
        waitTimeoutMs: 500,
        waitIntervalMs: 100,
      }),
    ).rejects.toBeInstanceOf(SyntaurError);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('wraps the spawn in launchctl asuser when the probe succeeds (macOS)', async () => {
    const probes: ProbeResult[] = ['refused', 'live'];
    const spawn = fakeSpawn();
    const exec = vi.fn(async () => ({ code: 0 }));
    await ensureDaemon(
      baseDarwin({ spawn, exec, probe: async () => probes.shift() ?? 'refused' }),
    );
    expect(exec).toHaveBeenCalledWith('/bin/launchctl', ['asuser', '501', '/usr/bin/true'], expect.any(Number));
    const [cmd, args] = spawn.mock.calls[0];
    expect(cmd).toBe('/bin/launchctl');
    expect(args).toEqual(['asuser', '501', '/usr/bin/node', '/opt/syntaur/dist/index.js', 'daemon', 'run']);
  });

  it('spawns plainly when the launchctl probe fails (macOS)', async () => {
    const probes: ProbeResult[] = ['refused', 'live'];
    const spawn = fakeSpawn();
    const exec = vi.fn(async () => ({ code: 1 }));
    await ensureDaemon(
      baseDarwin({ spawn, exec, probe: async () => probes.shift() ?? 'refused' }),
    );
    const [cmd, args] = spawn.mock.calls[0];
    expect(cmd).toBe('/usr/bin/node');
    expect(args).toEqual(['/opt/syntaur/dist/index.js', 'daemon', 'run']);
  });

  it('never probes launchctl off macOS', async () => {
    const probes: ProbeResult[] = ['refused', 'live'];
    const spawn = fakeSpawn();
    const exec = vi.fn(async () => ({ code: 0 }));
    await ensureDaemon({
      readFile: () => JSON.stringify(pointer),
      probe: async () => probes.shift() ?? 'refused',
      spawn,
      exec,
      platform: 'linux',
      execPath: '/usr/bin/node',
      cliEntryPath: '/opt/syntaur/dist/index.js',
      now: () => 0,
      sleep: async () => {},
    });
    expect(exec).not.toHaveBeenCalled();
    expect(spawn.mock.calls[0][0]).toBe('/usr/bin/node');
  });
});

describe('sendRequest', () => {
  it('round-trips a control reply over a real socket', async () => {
    const dir = await mkdtemp('/tmp/syn-cli-');
    const sock = join(dir, 'control.sock');
    const server = await bindUnixSocket(sock, (s) => {
      const dec = createLineDecoder();
      s.on('data', (chunk: Buffer) => {
        for (const _req of dec.push(chunk)) {
          s.write(encodeFrame({ ok: true, sessions: [] }));
        }
      });
    });
    try {
      const reply = await sendRequest(sock, { op: 'list' });
      expect(reply).toEqual({ ok: true, sessions: [] });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
