import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAttachClient, type AttachDeps } from '../attach-client.js';
import { encodeFrame } from '../protocol.js';
import type { AttachReply, ErrorReply } from '../types.js';

function fakeSocket() {
  const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  const writes: string[] = [];
  return {
    write: (d: string) => writes.push(d),
    on: (evt: string, cb: (arg?: unknown) => void) => {
      (handlers[evt] ||= []).push(cb);
    },
    destroy: vi.fn(),
    emitConnect: () => handlers['connect']?.forEach((h) => h()),
    emitData: (s: string) => handlers['data']?.forEach((h) => h(s)),
    emitClose: () => handlers['close']?.forEach((h) => h()),
    emitError: (e: Error) => handlers['error']?.forEach((h) => h(e)),
    frames: () =>
      writes
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { t: string; [k: string]: unknown }),
  };
}

function fakeStdin() {
  const handlers: Record<string, ((chunk: Buffer | string) => void)[]> = {};
  return {
    on: (evt: string, cb: (chunk: Buffer | string) => void) => {
      (handlers[evt] ||= []).push(cb);
    },
    removeListener: (evt: string, cb: (chunk: Buffer | string) => void) => {
      handlers[evt] = (handlers[evt] || []).filter((h) => h !== cb);
    },
    resume: vi.fn(),
    pause: vi.fn(),
    emitData: (chunk: Buffer | string) => handlers['data']?.forEach((h) => h(chunk)),
    dataListeners: () => (handlers['data'] || []).length,
  };
}

function fakeStdout() {
  const writes: (string | Buffer)[] = [];
  return {
    write: (d: string | Buffer) => writes.push(d),
    columns: 80,
    rows: 24,
    text: () => writes.map((w) => w.toString()).join(''),
  };
}

function fakeSignals() {
  const handlers: Record<string, (() => void)[]> = {};
  return {
    on: (sig: string, cb: () => void) => {
      (handlers[sig] ||= []).push(cb);
    },
    off: (sig: string, cb: () => void) => {
      handlers[sig] = (handlers[sig] || []).filter((h) => h !== cb);
    },
    fire: (sig: string) => handlers[sig]?.slice().forEach((h) => h()),
    count: (sig: string) => (handlers[sig] || []).length,
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

const liveAttach = async (): Promise<AttachReply> => ({
  ok: true,
  ptySock: '/pty.sock',
  rvSock: '/rv.sock',
  pid: 42,
});

function setup(over: { attachOp?: AttachDeps['attachOp'] } = {}) {
  const socket = fakeSocket();
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const signals = fakeSignals();
  const restoreStty = vi.fn();
  const setRawMode = vi.fn();
  const deps: AttachDeps = {
    attachOp: over.attachOp ?? liveAttach,
    connectPty: () => socket as never,
    stdin: stdin as never,
    stdout: stdout as never,
    signals,
    captureStty: () => 'STTY-SAVED',
    restoreStty,
    setRawMode,
    getSize: () => ({ cols: 120, rows: 40 }),
    resizeDebounceMs: 50,
  };
  const promise = runAttachClient({ short: 's1', cols: 80, rows: 24 }, deps);
  return { socket, stdin, stdout, signals, restoreStty, setRawMode, promise };
}

type Setup = ReturnType<typeof setup>;

function assertRestored(t: Setup): void {
  expect(t.setRawMode).toHaveBeenCalledWith(false);
  expect(t.restoreStty).toHaveBeenCalledWith('STTY-SAVED');
  const out = t.stdout.text();
  expect(out).toContain('\x1b[?25h'); // show cursor
  expect(out).toContain('\x1b[?1049l'); // leave alt-screen
  expect(out).toContain('\x1b[?1000l'); // mouse off
  expect(t.signals.count('SIGINT')).toBe(0); // handlers removed
  expect(t.signals.count('SIGWINCH')).toBe(0);
}

describe('runAttachClient', () => {
  afterEach(() => vi.useRealTimers());

  it('restores and reports on child exit ({t:exit})', async () => {
    const t = setup();
    await flush();
    t.socket.emitConnect();
    t.socket.emitData(encodeFrame({ t: 'exit', code: 0, signal: null }));
    const res = await t.promise;
    expect(res).toMatchObject({ reason: 'exit', code: 0, detached: false });
    expect(t.stdout.text()).toContain('[session exited');
    assertRestored(t);
  });

  it('restores on a mid-session socket close', async () => {
    const t = setup();
    await flush();
    t.socket.emitConnect();
    t.socket.emitClose();
    expect(await t.promise).toMatchObject({ reason: 'socket-closed' });
    assertRestored(t);
  });

  it('restores on a control-plane attach failure (dead session)', async () => {
    const t = setup({
      attachOp: async (): Promise<ErrorReply> => ({ ok: false, code: 'EDEAD', error: 'session is not live' }),
    });
    const res = await t.promise;
    expect(res).toMatchObject({ reason: 'connect-failed' });
    expect(res.error?.message).toBe('session is not live');
    assertRestored(t);
  });

  it('restores on a socket error before connect', async () => {
    const t = setup();
    await flush();
    t.socket.emitError(new Error('ECONNREFUSED'));
    const res = await t.promise;
    expect(res).toMatchObject({ reason: 'connect-failed' });
    assertRestored(t);
  });

  it('restores and detaches on SIGINT', async () => {
    const t = setup();
    await flush();
    t.socket.emitConnect();
    t.signals.fire('SIGINT');
    expect(await t.promise).toMatchObject({ reason: 'signal', detached: true });
    assertRestored(t);
  });

  it('restores and detaches on SIGTERM', async () => {
    const t = setup();
    await flush();
    t.socket.emitConnect();
    t.signals.fire('SIGTERM');
    expect(await t.promise).toMatchObject({ reason: 'signal', detached: true });
    assertRestored(t);
  });

  it('writes the snapshot and forwards stdin as base64 frames', async () => {
    const t = setup();
    await flush();
    t.socket.emitConnect();
    t.socket.emitData(encodeFrame({ t: 'snapshot', data: 'RESTORED SCREEN', cols: 80, rows: 24 }));
    expect(t.stdout.text()).toContain('RESTORED SCREEN');
    t.stdin.emitData('x');
    const stdinFrame = t.socket.frames().find((f) => f.t === 'stdin');
    expect(stdinFrame).toBeTruthy();
    expect(Buffer.from((stdinFrame as unknown as { b: string }).b, 'base64').toString('utf8')).toBe('x');
    t.socket.emitClose();
    await t.promise;
  });

  it('detaches on the Ctrl-] key (leaving the session running)', async () => {
    const t = setup();
    await flush();
    t.socket.emitConnect();
    t.stdin.emitData(Buffer.from([0x1d])); // Ctrl-]
    expect(await t.promise).toMatchObject({ reason: 'detach', detached: true });
    assertRestored(t);
  });

  it('forwards keystrokes typed before the detach key, then detaches', async () => {
    const t = setup();
    await flush();
    t.socket.emitConnect();
    t.stdin.emitData(Buffer.from([0x68, 0x69, 0x1d])); // "hi" then Ctrl-]
    const stdinFrame = t.socket.frames().find((f) => f.t === 'stdin');
    expect(stdinFrame).toBeTruthy();
    expect(Buffer.from((stdinFrame as unknown as { b: string }).b, 'base64').toString('utf8')).toBe('hi');
    expect(await t.promise).toMatchObject({ reason: 'detach', detached: true });
  });

  it('does NOT detach on Ctrl-C (0x03) — it forwards to the agent', async () => {
    const t = setup();
    await flush();
    t.socket.emitConnect();
    t.stdin.emitData(Buffer.from([0x03])); // Ctrl-C
    const stdinFrame = t.socket.frames().find((f) => f.t === 'stdin');
    expect(stdinFrame).toBeTruthy();
    expect(Buffer.from((stdinFrame as unknown as { b: string }).b, 'base64')).toEqual(Buffer.from([0x03]));
    // still attached — close to settle the promise
    t.socket.emitClose();
    expect(await t.promise).toMatchObject({ reason: 'socket-closed' });
  });

  it('ignores a null/malformed host frame without crashing', async () => {
    const t = setup();
    await flush();
    t.socket.emitConnect();
    expect(() => t.socket.emitData('null\n')).not.toThrow();
    expect(() => t.socket.emitData(encodeFrame({ t: 'out', b: null }))).not.toThrow();
    // a well-formed snapshot still renders afterward
    t.socket.emitData(encodeFrame({ t: 'snapshot', data: 'OK-SCREEN', cols: 80, rows: 24 }));
    expect(t.stdout.text()).toContain('OK-SCREEN');
    t.socket.emitClose();
    await t.promise;
  });

  it('debounces a resize storm to a single frame per 50ms window', async () => {
    vi.useFakeTimers();
    const t = setup();
    await flush();
    t.socket.emitConnect();
    t.signals.fire('SIGWINCH');
    t.signals.fire('SIGWINCH');
    t.signals.fire('SIGWINCH');
    vi.advanceTimersByTime(50);
    const resizes = t.socket.frames().filter((f) => f.t === 'resize');
    expect(resizes).toHaveLength(1);
    expect(resizes[0]).toMatchObject({ cols: 120, rows: 40 });
  });
});
