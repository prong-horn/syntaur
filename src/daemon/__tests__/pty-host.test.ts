import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:net';
import { SyntaurError } from '../../errors.js';
import {
  createScreenBuffer,
  runPtyHost,
  scheduleQuiescentSnapshot,
  type PtyHostConfig,
  type PtyLike,
  type ScreenBuffer,
  type SocketLike,
} from '../pty-host.js';
import { encodeFrame } from '../protocol.js';
import type { JobState } from '../types.js';

// ── Fakes ────────────────────────────────────────────────────────────────────

function fakePty() {
  let dataCb: ((d: string) => void) | undefined;
  let exitCb: ((e: { exitCode: number; signal?: number }) => void) | undefined;
  const writes: string[] = [];
  const resizes: [number, number][] = [];
  const kills: (string | undefined)[] = [];
  const pty: PtyLike & {
    emit: (d: string) => void;
    fireExit: (code: number, signal?: number) => void;
    writes: string[];
    resizes: [number, number][];
    kills: (string | undefined)[];
  } = {
    pid: 12345,
    onData: (cb) => {
      dataCb = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
    },
    write: (d) => writes.push(d),
    resize: (c, r) => resizes.push([c, r]),
    kill: (sig) => kills.push(sig),
    emit: (d) => dataCb?.(d),
    fireExit: (code, signal) => exitCb?.({ exitCode: code, signal }),
    writes,
    resizes,
    kills,
  };
  return pty;
}

function fakeSocket() {
  const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  const sent: string[] = [];
  const on = ((evt: string, cb: (arg?: unknown) => void) => {
    (handlers[evt] ||= []).push(cb);
  }) as SocketLike['on'];
  const socket = {
    write: (d: string) => sent.push(d),
    on,
    end: () => {},
    destroy: () => {},
    recv: (s: string) => handlers['data']?.forEach((h) => h(s)),
    close: () => handlers['close']?.forEach((h) => h()),
    frames: () =>
      sent
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { t: string; [k: string]: unknown }),
  };
  return socket;
}

function fakeBind() {
  const conns: Record<string, (s: SocketLike) => void> = {};
  const closed: string[] = [];
  const bind = vi.fn(async (path: string, onConnection: (s: unknown) => void) => {
    conns[path] = onConnection as (s: SocketLike) => void;
    return { close: () => closed.push(path) } as unknown as Server;
  });
  return { bind: bind as never, connect: (path: string, s: SocketLike) => conns[path]?.(s), closed, bindSpy: bind };
}

function fakeScreen(): ScreenBuffer {
  let buf = '';
  let cols = 80;
  let rows = 24;
  return {
    write: (d) => {
      buf += d;
    },
    resize: (c, r) => {
      cols = c;
      rows = r;
    },
    snapshot: () => ({ data: buf, cols, rows }),
    dispose: () => {},
  };
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

function baseConfig(over: Partial<PtyHostConfig> = {}): PtyHostConfig {
  return {
    short: 'aaa',
    daemonId: 'd1',
    agent: 'bash',
    argv: ['/bin/bash', '-l'],
    cwd: '/work',
    cols: 80,
    rows: 24,
    ...over,
  };
}

// ── ScreenBuffer (real @xterm/headless) ──────────────────────────────────────

describe('createScreenBuffer', () => {
  it('snapshot reflects fed bytes', async () => {
    const screen = createScreenBuffer(80, 24);
    await new Promise<void>((res) => screen.write('hello \x1b[32mgreen\x1b[0m world', res));
    const snap = screen.snapshot();
    expect(snap.data).toContain('hello');
    expect(snap.data).toContain('green');
    expect(snap.cols).toBe(80);
    expect(snap.rows).toBe(24);
    screen.dispose();
  });

  it('reflects a resize', () => {
    const screen = createScreenBuffer(80, 24);
    screen.resize(120, 40);
    expect(screen.snapshot().cols).toBe(120);
    expect(screen.snapshot().rows).toBe(40);
    screen.dispose();
  });
});

// ── Quiescence-debounced snapshot ────────────────────────────────────────────

describe('scheduleQuiescentSnapshot', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires after the idle window with no output', () => {
    const fire = vi.fn();
    scheduleQuiescentSnapshot(fire, { idleMs: 100, capMs: 400 });
    vi.advanceTimersByTime(99);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('output at t+50ms defers the snapshot (idle timer resets)', () => {
    const fire = vi.fn();
    const s = scheduleQuiescentSnapshot(fire, { idleMs: 100, capMs: 400 });
    vi.advanceTimersByTime(50);
    s.bump(); // new output
    vi.advanceTimersByTime(50); // 100ms since start but only 50ms idle
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50); // now 100ms idle
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('caps at 400ms even under continuous output', () => {
    const fire = vi.fn();
    const s = scheduleQuiescentSnapshot(fire, { idleMs: 100, capMs: 400 });
    for (let t = 0; t < 400; t += 50) {
      vi.advanceTimersByTime(50);
      s.bump();
    }
    expect(fire).toHaveBeenCalledTimes(1); // cap fired at 400ms
  });

  it('fires only once', () => {
    const fire = vi.fn();
    scheduleQuiescentSnapshot(fire, { idleMs: 100, capMs: 400 });
    vi.advanceTimersByTime(1000);
    expect(fire).toHaveBeenCalledTimes(1);
  });
});

// ── runPtyHost orchestration ──────────────────────────────────────────────────

describe('runPtyHost', () => {
  const originalRuntime = process.env.SYNTAUR_RUNTIME_DIR;
  let writeJobState: ReturnType<typeof vi.fn>;
  let appendTimeline: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.SYNTAUR_RUNTIME_DIR = '/tmp/syntaur-ptyhost-test';
    writeJobState = vi.fn();
    appendTimeline = vi.fn();
  });
  afterEach(() => {
    if (originalRuntime === undefined) delete process.env.SYNTAUR_RUNTIME_DIR;
    else process.env.SYNTAUR_RUNTIME_DIR = originalRuntime;
    vi.useRealTimers();
  });

  function boot(over: Partial<PtyHostConfig> = {}) {
    const pty = fakePty();
    const screen = fakeScreen();
    const bind = fakeBind();
    return {
      pty,
      screen,
      bind,
      promise: runPtyHost(baseConfig(over), {
        ptyFactory: () => pty,
        bindSocket: bind.bind,
        createScreen: () => screen,
        writeJobState,
        appendTimeline,
        procStart: () => 'Wed Jul 9 12:00:00 2026',
        now: () => 0,
      }),
    };
  }

  it('writes initial working state + timeline and binds both sockets', async () => {
    const { bind, promise } = boot();
    await promise;
    const first = writeJobState.mock.calls[0][0] as JobState;
    expect(first.state).toBe('working');
    expect(first.pid).toBe(12345);
    expect(first.pidStartedAt).toBe('Wed Jul 9 12:00:00 2026');
    expect(appendTimeline).toHaveBeenCalledWith('aaa', expect.objectContaining({ event: 'spawned' }));
    expect(bind.bindSpy).toHaveBeenCalledTimes(2);
  });

  it('resizes PTY to the attacher and delivers a snapshot after quiescence', async () => {
    vi.useFakeTimers();
    const { pty, bind, promise } = boot();
    await promise;
    const sock = fakeSocket();
    bind.connect('/tmp/syntaur-ptyhost-test/d1/pty/aaa.sock', sock);
    sock.recv(encodeFrame({ t: 'attach', cols: 100, rows: 40 }));
    // resize propagates immediately
    expect(pty.resizes).toContainEqual([100, 40]);
    vi.advanceTimersByTime(100);
    const snapshot = sock.frames().find((f) => f.t === 'snapshot');
    expect(snapshot).toBeTruthy();
    expect(snapshot).toMatchObject({ cols: 100, rows: 40 });
  });

  it('streams PTY output to live clients only', async () => {
    vi.useFakeTimers();
    const { pty, bind, promise } = boot();
    await promise;
    const pending = fakeSocket();
    bind.connect('/tmp/syntaur-ptyhost-test/d1/pty/aaa.sock', pending);
    // pending client (no snapshot yet) must not receive out frames
    pty.emit('early');
    expect(pending.frames().some((f) => f.t === 'out')).toBe(false);

    // attach + settle → live, then output streams
    pending.recv(encodeFrame({ t: 'attach', cols: 80, rows: 24 }));
    vi.advanceTimersByTime(100);
    pty.emit('later');
    const out = pending.frames().find((f) => f.t === 'out');
    expect(out).toBeTruthy();
    expect(Buffer.from((out as unknown as { b: string }).b, 'base64').toString('utf8')).toBe('later');
  });

  it('forwards stdin, resize, and kill frames to the PTY', async () => {
    vi.useFakeTimers();
    const { pty, bind, promise } = boot();
    await promise;
    const sock = fakeSocket();
    bind.connect('/tmp/syntaur-ptyhost-test/d1/pty/aaa.sock', sock);
    sock.recv(encodeFrame({ t: 'stdin', b: b64('ls\n') }));
    sock.recv(encodeFrame({ t: 'resize', cols: 120, rows: 50 }));
    sock.recv(encodeFrame({ t: 'kill', sig: 'SIGTERM' }));
    expect(pty.writes).toContain('ls\n');
    expect(pty.resizes).toContainEqual([120, 50]);
    expect(pty.kills).toContain('SIGTERM');
  });

  it('sends the rv state record on connect', async () => {
    const { bind, promise } = boot();
    await promise;
    const rv = fakeSocket();
    bind.connect('/tmp/syntaur-ptyhost-test/d1/rv/aaa.sock', rv);
    const state = rv.frames().find((f) => f.t === 'state');
    expect(state).toMatchObject({ t: 'state', record: expect.objectContaining({ state: 'working' }) });
  });

  it('on exit: emits {t:exit}, writes final state, settles rv, closes sockets', async () => {
    vi.useFakeTimers();
    const { pty, screen, bind, promise } = boot();
    await promise;
    screen.write('final screen contents');
    const pty0 = fakeSocket();
    bind.connect('/tmp/syntaur-ptyhost-test/d1/pty/aaa.sock', pty0);
    const rv = fakeSocket();
    bind.connect('/tmp/syntaur-ptyhost-test/d1/rv/aaa.sock', rv);

    pty.fireExit(0, undefined);

    const finalState = writeJobState.mock.calls.at(-1)?.[0] as JobState;
    expect(finalState.state).toBe('done');
    expect(finalState.exitCode).toBe(0);
    expect(finalState.lastScreen).toContain('final screen contents');
    expect(appendTimeline).toHaveBeenCalledWith('aaa', expect.objectContaining({ event: 'exited' }));
    expect(pty0.frames().find((f) => f.t === 'exit')).toMatchObject({ code: 0, signal: null });
    expect(rv.frames().find((f) => f.t === 'settled')).toBeTruthy();
    expect(bind.closed).toEqual(
      expect.arrayContaining([
        '/tmp/syntaur-ptyhost-test/d1/pty/aaa.sock',
        '/tmp/syntaur-ptyhost-test/d1/rv/aaa.sock',
      ]),
    );
  });

  it('maps a non-zero exit to failed and a signal to stopped', async () => {
    const failed = boot();
    await failed.promise;
    failed.pty.fireExit(1, undefined);
    expect((writeJobState.mock.calls.at(-1)?.[0] as JobState).state).toBe('failed');

    writeJobState.mockClear();
    const stopped = boot({ short: 'bbb' });
    await stopped.promise;
    stopped.pty.fireExit(0, 15);
    const s = writeJobState.mock.calls.at(-1)?.[0] as JobState;
    expect(s.state).toBe('stopped');
    expect(s.exitSignal).toBe(15);
  });

  it('replays an exit that fires BEFORE the socket binds complete (fast child)', async () => {
    // A fast command (e.g. /bin/true) can exit before the async binds resolve.
    // node-pty does not replay 'exit' to a late listener, so the listener must
    // be registered before the binds and buffer an early exit.
    const pty = fakePty();
    const screen = fakeScreen();
    let releaseBinds!: () => void;
    const gate = new Promise<void>((r) => {
      releaseBinds = r;
    });
    const bind = (async () => {
      await gate; // hold both binds open
      return { close: () => {} } as unknown as Server;
    }) as never;

    const promise = runPtyHost(baseConfig(), {
      ptyFactory: () => pty,
      bindSocket: bind,
      createScreen: () => screen,
      writeJobState,
      appendTimeline,
      procStart: () => 'START',
      now: () => 0,
    });

    // Binds are blocked; the onExit listener is already registered. Fire the
    // child's exit now — it must be buffered, not lost.
    pty.fireExit(0, undefined);
    expect(writeJobState).toHaveBeenCalledTimes(1); // only the initial 'working'

    releaseBinds();
    await promise;

    const finalState = writeJobState.mock.calls.at(-1)?.[0] as JobState;
    expect(finalState.state).toBe('done');
    expect(finalState.exitCode).toBe(0);
    expect(appendTimeline).toHaveBeenCalledWith('aaa', expect.objectContaining({ event: 'exited' }));
  });

  it('ignores a null/malformed pty frame without crashing', async () => {
    const { pty, bind, promise } = boot();
    await promise;
    const sock = fakeSocket();
    bind.connect('/tmp/syntaur-ptyhost-test/d1/pty/aaa.sock', sock);
    expect(() => sock.recv('null\n')).not.toThrow();
    expect(() => sock.recv('5\n')).not.toThrow();
    expect(() => sock.recv('[1,2]\n')).not.toThrow();
    // the connection still works afterward
    sock.recv(encodeFrame({ t: 'stdin', b: b64('ok') }));
    expect(pty.writes).toContain('ok');
  });

  it('propagates a fatal live-socket bind error', async () => {
    const pty = fakePty();
    await expect(
      runPtyHost(baseConfig(), {
        ptyFactory: () => pty,
        createScreen: () => fakeScreen(),
        writeJobState,
        appendTimeline,
        procStart: () => null,
        bindSocket: (async () => {
          throw new SyntaurError('A live process already owns the socket.', { remediation: 'stop it' });
        }) as never,
      }),
    ).rejects.toBeInstanceOf(SyntaurError);
  });
});
