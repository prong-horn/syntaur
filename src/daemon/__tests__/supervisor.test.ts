import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SyntaurError } from '../../errors.js';
import { createDaemon, toSubscribeReply, type DaemonDeps, type DaemonSpawnFn } from '../supervisor.js';
import { appendLog, tailLog } from '../log.js';
import { writeJobState } from '../jobs.js';
import { readRoster, writeRoster } from '../roster.js';
import { daemonLockPath, ptySockPath, rosterPath, rvSockPath } from '../paths.js';
import type { JobState, ListReply, RosterEntry, StateRecord, StatusReply } from '../types.js';

const START = 'Wed Jul 9 12:00:00 2026';

function fakeChild(pid = 9999): ChildProcess {
  return { pid, unref: vi.fn() } as unknown as ChildProcess;
}

const fakeBindOk = (): DaemonDeps['bindSocket'] =>
  (async () => ({ close: (cb?: () => void) => cb?.() })) as never;

function rosterEntry(over: Partial<RosterEntry> = {}): RosterEntry {
  return {
    short: 'aaa',
    pid: 100,
    pidStartedAt: START,
    ptySock: '/tmp/x/pty/aaa.sock',
    rvSock: '/tmp/x/rv/aaa.sock',
    agent: 'bash',
    cwd: '/work',
    createdAt: '2026-07-09T12:00:00Z',
    ...over,
  };
}

function jobState(over: Partial<JobState> = {}): JobState {
  return {
    short: 'zzz',
    agent: 'bash',
    argv: ['/bin/bash'],
    cwd: '/work',
    state: 'working',
    pid: 5000,
    pidStartedAt: START,
    sessionId: null,
    cols: 80,
    rows: 24,
    createdAt: '2026-07-09T12:00:00Z',
    updatedAt: '2026-07-09T12:00:00Z',
    daemonId: 'oldd',
    ptySock: '/tmp/x/pty/zzz.sock',
    rvSock: '/tmp/x/rv/zzz.sock',
    hostPid: 100,
    hostPidStartedAt: START,
    ...over,
  };
}

describe('supervisor', () => {
  const origHome = process.env.SYNTAUR_HOME;
  const origRuntime = process.env.SYNTAUR_RUNTIME_DIR;
  let home: string;
  let runtime: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-sup-'));
    runtime = await mkdtemp('/tmp/syn-rt-'); // short path — keeps sockets under sun_path
    process.env.SYNTAUR_HOME = home;
    process.env.SYNTAUR_RUNTIME_DIR = runtime;
  });
  afterEach(async () => {
    if (origHome === undefined) delete process.env.SYNTAUR_HOME;
    else process.env.SYNTAUR_HOME = origHome;
    if (origRuntime === undefined) delete process.env.SYNTAUR_RUNTIME_DIR;
    else process.env.SYNTAUR_RUNTIME_DIR = origRuntime;
    await rm(home, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  });

  function daemon(over: DaemonDeps = {}) {
    return createDaemon({
      genDaemonId: () => 'daem',
      genShort: () => 's1',
      procStart: () => START,
      isPidAlive: () => true,
      now: () => 0,
      log: () => {},
      ...over,
    });
  }

  it('dispatch passes argv verbatim to the spawn seam and writes a roster entry', async () => {
    const spawn = vi.fn<DaemonSpawnFn>(() => fakeChild(9999));
    const d = daemon({ spawn });
    const reply = await d.handle({ op: 'dispatch', argv: ['/usr/bin/codex', 'exec', '--foo'], cwd: '/work', name: 'my' });
    expect(reply).toEqual({ ok: true, short: 's1', pid: 9999 });

    const [cmd, args, opts] = spawn.mock.calls[0];
    expect(cmd).toBe(process.execPath);
    const dashIdx = args.indexOf('--');
    expect(args.slice(dashIdx + 1)).toEqual(['/usr/bin/codex', 'exec', '--foo']);
    expect(args).toContain('--short');
    expect(args).toContain('s1');
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' });

    expect(readRoster(rosterPath()).entries.map((e) => e.short)).toContain('s1');
  });

  it('attach returns socket paths for a live session and errors for dead/unknown', async () => {
    const spawn = vi.fn(() => fakeChild(9999));
    const live = daemon({ spawn, isPidAlive: () => true });
    await live.handle({ op: 'dispatch', argv: ['bash'], cwd: '/w' });
    const ok = await live.handle({ op: 'attach', short: 's1', cols: 80, rows: 24 });
    expect(ok).toMatchObject({ ok: true, pid: 9999 });
    expect((ok as { ptySock: string }).ptySock).toContain('s1.sock');

    const dead = daemon({ spawn, genShort: () => 's2', isPidAlive: () => false });
    await dead.handle({ op: 'dispatch', argv: ['bash'], cwd: '/w' });
    expect(await dead.handle({ op: 'attach', short: 's2', cols: 80, rows: 24 })).toMatchObject({ ok: false, code: 'EDEAD' });

    expect(await live.handle({ op: 'attach', short: 'nope', cols: 80, rows: 24 })).toMatchObject({
      ok: false,
      code: 'ENOSESSION',
    });
  });

  it('kill escalates SIGINT → SIGTERM → SIGKILL and drops the session', async () => {
    const kills: (string | number)[] = [];
    const d = daemon({
      spawn: vi.fn(() => fakeChild(9999)),
      isPidAlive: () => true, // never dies → full escalation
      kill: (_pid, sig) => kills.push(sig),
      sleep: async () => {},
      killWaitMs: 0,
    });
    await d.handle({ op: 'dispatch', argv: ['bash'], cwd: '/w' });
    expect(await d.handle({ op: 'kill', short: 's1' })).toEqual({ ok: true });
    expect(kills).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
    expect(d.hasSession('s1')).toBe(false);
  });

  it('kill does not signal a recycled host pid (procStart mismatch) but still drops the session', async () => {
    const kills: (string | number)[] = [];
    let startVal = START;
    const d = daemon({
      spawn: vi.fn(() => fakeChild(9999)),
      procStart: () => startVal,
      isPidAlive: () => true,
      kill: (_pid, sig) => kills.push(sig),
      sleep: async () => {},
      killWaitMs: 0,
    });
    await d.handle({ op: 'dispatch', argv: ['bash'], cwd: '/w' }); // records hostPidStartedAt = START
    startVal = 'RECYCLED'; // the pid now belongs to a different process
    expect(await d.handle({ op: 'kill', short: 's1' })).toEqual({ ok: true });
    expect(kills).toEqual([]); // never signaled the stranger
    expect(d.hasSession('s1')).toBe(false); // but the session is forgotten
  });

  it('list + status reflect dispatched sessions', async () => {
    const d = daemon({ spawn: vi.fn(() => fakeChild(9999)) });
    await d.handle({ op: 'dispatch', argv: ['/bin/bash'], cwd: '/w', name: 'shell1' });
    const listed = (await d.handle({ op: 'list' })) as ListReply;
    expect(listed.sessions[0]).toMatchObject({ short: 's1', agent: 'bash', state: 'working', name: 'shell1' });
    const st = (await d.handle({ op: 'status' })) as StatusReply;
    expect(st).toMatchObject({ ok: true, daemonId: 'daem' });
    expect(st.sessions).toHaveLength(1);
  });

  it('startup adopts live roster hosts and drops dead ones', async () => {
    writeRoster(
      {
        daemonId: 'old',
        updatedAt: '',
        entries: [rosterEntry({ short: 'live', pid: 100 }), rosterEntry({ short: 'dead', pid: 200 })],
      },
      rosterPath(),
    );
    const d = daemon({
      isPidAlive: (pid) => pid === 100,
      bindSocket: fakeBindOk(),
      probe: async () => 'refused',
    });
    expect(await d.start()).toBe('started');
    expect(d.hasSession('live')).toBe(true);
    expect(d.hasSession('dead')).toBe(false);
  });

  it('reconcile adopts a live host missing from a corrupt roster (not reaped)', async () => {
    writeFileSync(rosterPath(), '{ corrupt not json');
    const ptySock = ptySockPath('oldd', 'orphan');
    const rvSock = rvSockPath('oldd', 'orphan');
    writeJobState(jobState({ short: 'orphan', hostPid: 100, ptySock, rvSock }));

    const d = daemon({
      isPidAlive: (pid) => pid === 100,
      bindSocket: fakeBindOk(),
      probe: async (p) => (p === ptySock ? 'live' : 'refused'),
    });
    expect(await d.start()).toBe('started');
    expect(d.hasSession('orphan')).toBe(true);
    expect(readRoster(rosterPath()).entries.map((e) => e.short)).toContain('orphan');
  });

  it('reconcile reaps the orphaned sockets of a dead host', async () => {
    const ptySock = join(runtime, 'oldd', 'pty', 'deadh.sock');
    const rvSock = join(runtime, 'oldd', 'rv', 'deadh.sock');
    mkdirSync(dirname(ptySock), { recursive: true });
    mkdirSync(dirname(rvSock), { recursive: true });
    writeFileSync(ptySock, '');
    writeFileSync(rvSock, '');
    writeJobState(jobState({ short: 'deadh', hostPid: 200, ptySock, rvSock }));

    const d = daemon({ isPidAlive: () => false, bindSocket: fakeBindOk(), probe: async () => 'refused' });
    await d.start();
    expect(d.hasSession('deadh')).toBe(false);
    expect(existsSync(ptySock)).toBe(false);
    expect(existsSync(rvSock)).toBe(false);
  });

  it('reconcile does NOT reap an unknown-identity host (transient ps failure)', async () => {
    const ptySock = join(runtime, 'oldd', 'pty', 'flaky.sock');
    const rvSock = join(runtime, 'oldd', 'rv', 'flaky.sock');
    mkdirSync(dirname(ptySock), { recursive: true });
    mkdirSync(dirname(rvSock), { recursive: true });
    writeFileSync(ptySock, '');
    writeFileSync(rvSock, '');
    writeJobState(jobState({ short: 'flaky', hostPid: 200, ptySock, rvSock }));

    const d = daemon({
      isPidAlive: () => true, // alive…
      procStart: () => null, // …but start-time unreadable → identity 'unknown'
      bindSocket: fakeBindOk(),
      probe: async () => 'refused', // socket not answering
    });
    await d.start();
    expect(d.hasSession('flaky')).toBe(false); // not adopted (socket not live)
    // …but its sockets are left intact — identity was unconfirmed, not dead.
    expect(existsSync(ptySock)).toBe(true);
    expect(existsSync(rvSock)).toBe(true);
  });

  it('yields to a live daemon holding the lock', async () => {
    writeFileSync(daemonLockPath(), JSON.stringify({ pid: 111, procStart: START, daemonId: 'other' }));
    const d = daemon({ isPidAlive: (pid) => pid === 111, bindSocket: fakeBindOk() });
    expect(await d.start()).toBe('yielded');
  });

  it('yields and releases the lock when control.sock has a live owner', async () => {
    const d = daemon({
      isPidAlive: () => false, // lock is free → acquired
      bindSocket: (async () => {
        throw new SyntaurError('A live process already owns the socket.', { remediation: 'stop it' });
      }) as never,
    });
    expect(await d.start()).toBe('yielded');
    expect(existsSync(daemonLockPath())).toBe(false); // released on yield
  });
});

describe('toSubscribeReply', () => {
  it('preserves the t discriminator when relaying an rv frame (D9)', () => {
    const record: StateRecord = {
      short: 'aaa',
      state: 'blocked',
      needs: 'permission prompt',
      pid: 123,
      cols: 80,
      rows: 24,
      updatedAt: '2026-07-19T00:00:00.000Z',
    };
    expect(toSubscribeReply({ t: 'state', record })).toEqual({ ok: true, t: 'state', record });
    expect(toSubscribeReply({ t: 'settled', record })).toEqual({ ok: true, t: 'settled', record });
  });
});

describe('daemon log', () => {
  let logPath: string;
  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'syntaur-log-'));
    logPath = join(dir, 'daemon.log');
  });

  it('appends timestamped lines and tails the last N', () => {
    appendLog('first', { path: logPath, now: () => 0 });
    appendLog('second', { path: logPath, now: () => 1000 });
    appendLog('third', { path: logPath, now: () => 2000 });
    const tail = tailLog(2, { path: logPath });
    expect(tail).toHaveLength(2);
    expect(tail[0]).toContain('second');
    expect(tail[1]).toContain('third');
    expect(tail[1]).toMatch(/^\d{4}-\d\d-\d\dT/); // ISO timestamp prefix
  });

  it('returns [] for a missing log', () => {
    expect(tailLog(5, { path: '/tmp/syntaur-nonexistent-daemon.log' })).toEqual([]);
  });
});
