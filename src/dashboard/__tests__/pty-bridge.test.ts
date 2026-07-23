import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPtyBridge,
  isLoopbackAddress,
  validDim,
  MAX_COLS,
  HIGH_WATER_BYTES,
  LOW_WATER_BYTES,
  RESIZE_DEBOUNCE_MS,
  type BridgeWs,
  type BridgeUpstream,
} from '../pty-bridge.js';
import { encodeFrame } from '../../daemon/protocol.js';
import type { AttachReply, ErrorReply, PtyHostFrame } from '../../daemon/types.js';

class FakeWs implements BridgeWs {
  sent: string[] = [];
  closed = false;
  terminated = false;
  bufferedAmount = 0;
  private h: Record<string, (...a: any[]) => void> = {};
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {
    this.closed = true;
  }
  terminate(): void {
    this.terminated = true;
    this.closed = true;
  }
  on(ev: string, cb: (...a: any[]) => void): void {
    this.h[ev] = cb;
  }
  msg(data: unknown, isBinary = false): void {
    this.h.message?.(data, isBinary);
  }
  frames(): any[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

class FakeUpstream implements BridgeUpstream {
  written: string[] = [];
  paused = false;
  destroyed = false;
  writeReturn = true;
  private h: Record<string, (...a: any[]) => void> = {};
  write(d: string): boolean {
    this.written.push(d);
    return this.writeReturn;
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  destroy(): void {
    this.destroyed = true;
  }
  on(ev: string, cb: (...a: any[]) => void): void {
    this.h[ev] = cb;
  }
  connect(): void {
    this.h.connect?.();
  }
  data(chunk: Buffer | string): void {
    this.h.data?.(chunk);
  }
  close(): void {
    this.h.close?.();
  }
  error(e: Error): void {
    this.h.error?.(e);
  }
  drain(): void {
    this.h.drain?.();
  }
  frames(): any[] {
    return this.written.map((s) => JSON.parse(s.replace(/\n$/, '')));
  }
}

const okReply: AttachReply = { ok: true, ptySock: '/tmp/x.pty.sock', rvSock: '/tmp/x.rv.sock', pid: 9 };

function setup(opts: { reply?: AttachReply | ErrorReply | null; attachThrows?: boolean; connectThrows?: boolean } = {}) {
  const ws = new FakeWs();
  const upstream = new FakeUpstream();
  const bridge = createPtyBridge({
    attachOp: async () => {
      if (opts.attachThrows) throw new Error('boom');
      return opts.reply === undefined ? okReply : opts.reply;
    },
    connectPty: () => {
      if (opts.connectThrows) throw new Error('nope');
      return upstream;
    },
  });
  return { ws, upstream, bridge };
}

/** Complete the async attach handshake and drive the upstream 'connect'. */
async function attach(ws: FakeWs, upstream: FakeUpstream, bridge: ReturnType<typeof createPtyBridge>, dims = { cols: 80, rows: 24 }): Promise<void> {
  bridge.handleConnection(ws, { short: 'ab12', ...dims });
  await vi.advanceTimersByTimeAsync(0); // resolve attachOp → connectPty
  upstream.connect();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('isLoopbackAddress / validDim', () => {
  it('accepts only loopback forms', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect(isLoopbackAddress(a)).toBe(true);
    for (const a of ['192.168.1.5', '10.0.0.1', '::2', undefined, null, ''])
      expect(isLoopbackAddress(a)).toBe(false);
  });
  it('bounds dimensions to finite safe integers in range', () => {
    expect(validDim(80, MAX_COLS)).toBe(80);
    expect(validDim(1, MAX_COLS)).toBe(1);
    expect(validDim(MAX_COLS, MAX_COLS)).toBe(MAX_COLS);
    for (const bad of [0, -5, MAX_COLS + 1, 1.5, NaN, Infinity, '80', null])
      expect(validDim(bad, MAX_COLS)).toBeNull();
  });
});

describe('createPtyBridge — attach + pass-through', () => {
  it('writes the attach frame on upstream connect and forwards snapshot + out verbatim', async () => {
    const { ws, upstream, bridge } = setup();
    await attach(ws, upstream, bridge, { cols: 100, rows: 30 });
    expect(upstream.frames()[0]).toEqual({ t: 'attach', cols: 100, rows: 30 });
    const snap: PtyHostFrame = { t: 'snapshot', data: '\x1b[Hhi', cols: 100, rows: 30 };
    const out: PtyHostFrame = { t: 'out', b: Buffer.from('x').toString('base64') };
    upstream.data(encodeFrame(snap) + encodeFrame(out));
    expect(ws.frames()).toEqual([snap, out]);
  });

  it('closes the ws on an exit frame', async () => {
    const { ws, upstream, bridge } = setup();
    await attach(ws, upstream, bridge);
    upstream.data(encodeFrame({ t: 'exit', code: 0, signal: null }));
    expect(ws.frames().at(-1)).toEqual({ t: 'exit', code: 0, signal: null });
    expect(ws.closed).toBe(true);
    expect(upstream.destroyed).toBe(true);
  });
});

describe('createPtyBridge — view-only gate + validation', () => {
  it('drops stdin until take-control, then forwards it; never forwards kill', async () => {
    const { ws, upstream, bridge } = setup();
    await attach(ws, upstream, bridge);
    upstream.written.length = 0; // ignore the attach frame
    ws.msg(JSON.stringify({ t: 'stdin', b: Buffer.from('a').toString('base64') }));
    expect(upstream.frames()).toEqual([]); // dropped — view-only
    ws.msg(JSON.stringify({ t: 'take-control' }));
    ws.msg(JSON.stringify({ t: 'stdin', b: Buffer.from('b').toString('base64') }));
    expect(upstream.frames()).toEqual([{ t: 'stdin', b: Buffer.from('b').toString('base64') }]);
    ws.msg(JSON.stringify({ t: 'kill', sig: 'SIGKILL' }));
    expect(upstream.frames().some((f) => f.t === 'kill')).toBe(false);
  });

  it('drops invalid resize dims and debounces valid ones', async () => {
    const { ws, upstream, bridge } = setup();
    await attach(ws, upstream, bridge);
    upstream.written.length = 0;
    for (const bad of [0, -1, 99999, 1.5]) ws.msg(JSON.stringify({ t: 'resize', cols: bad, rows: 24 }));
    ws.msg(JSON.stringify({ t: 'resize', cols: 120, rows: 40 }));
    ws.msg(JSON.stringify({ t: 'resize', cols: 130, rows: 50 })); // supersedes within debounce
    await vi.advanceTimersByTimeAsync(RESIZE_DEBOUNCE_MS + 1);
    const resizes = upstream.frames().filter((f) => f.t === 'resize');
    expect(resizes).toEqual([{ t: 'resize', cols: 130, rows: 50 }]);
  });

  it('drops stdin whose payload is not canonical bounded base64', async () => {
    const { ws, upstream, bridge } = setup();
    await attach(ws, upstream, bridge);
    upstream.written.length = 0;
    ws.msg(JSON.stringify({ t: 'take-control' }));
    for (const bad of ['!!!!', 'abc', 'aa=a', 'A'.repeat((512 << 10) + 4)]) {
      ws.msg(JSON.stringify({ t: 'stdin', b: bad }));
    }
    expect(upstream.frames().filter((f) => f.t === 'stdin')).toEqual([]);
    ws.msg(JSON.stringify({ t: 'stdin', b: 'QQ==' })); // valid
    expect(upstream.frames().filter((f) => f.t === 'stdin')).toEqual([{ t: 'stdin', b: 'QQ==' }]);
  });

  it('rejects binary ws frames and tolerates malformed JSON without throwing', async () => {
    const { ws, upstream, bridge } = setup();
    await attach(ws, upstream, bridge);
    upstream.written.length = 0;
    ws.msg(Buffer.from(JSON.stringify({ t: 'take-control' })), true); // binary → ignored
    ws.msg('{not json');
    ws.msg(JSON.stringify({ t: 'stdin', b: 'AA==' })); // still view-only (take-control was binary)
    expect(upstream.frames()).toEqual([]);
  });

  it('falls back to default dims when the initial query dims are invalid', async () => {
    const { ws, upstream, bridge } = setup();
    bridge.handleConnection(ws, { short: 'ab12', cols: 0, rows: -3 });
    await vi.advanceTimersByTimeAsync(0);
    upstream.connect();
    expect(upstream.frames()[0]).toEqual({ t: 'attach', cols: 80, rows: 24 });
  });
});

describe('createPtyBridge — readiness gate (frames before upstream)', () => {
  it('retains control + resize and queues post-control stdin until ready, applying control before stdin', async () => {
    const { ws, upstream, bridge } = setup();
    bridge.handleConnection(ws, { short: 'ab12', cols: 80, rows: 24 });
    // client acts before attachOp resolves / upstream connects
    ws.msg(JSON.stringify({ t: 'take-control' }));
    ws.msg(JSON.stringify({ t: 'resize', cols: 90, rows: 30 }));
    ws.msg(JSON.stringify({ t: 'stdin', b: Buffer.from('typed').toString('base64') }));
    await vi.advanceTimersByTimeAsync(0);
    upstream.connect();
    const frames = upstream.frames();
    expect(frames[0]).toEqual({ t: 'attach', cols: 80, rows: 24 });
    expect(frames).toContainEqual({ t: 'resize', cols: 90, rows: 30 });
    expect(frames).toContainEqual({ t: 'stdin', b: Buffer.from('typed').toString('base64') });
    // control (resize) applied before the drained stdin
    const resizeIdx = frames.findIndex((f) => f.t === 'resize');
    const stdinIdx = frames.findIndex((f) => f.t === 'stdin');
    expect(resizeIdx).toBeLessThan(stdinIdx);
  });

  it('closes with {t:unavailable} when the pre-ready stdin queue overflows', async () => {
    const { ws, bridge } = setup();
    bridge.handleConnection(ws, { short: 'ab12', cols: 80, rows: 24 });
    ws.msg(JSON.stringify({ t: 'take-control' }));
    // Each frame is valid, bounded base64 (≤512 KiB); enough of them overflow the
    // 1 MiB pre-ready queue and close the connection.
    const chunk = 'A'.repeat(400_000); // %4 == 0, valid base64
    for (let i = 0; i < 4 && !ws.closed; i += 1) ws.msg(JSON.stringify({ t: 'stdin', b: chunk }));
    expect(ws.frames().at(-1)).toEqual({ t: 'unavailable' });
    expect(ws.closed).toBe(true);
  });
});

describe('createPtyBridge — unavailability paths', () => {
  it.each([
    ['null reply', { reply: null }],
    ['error reply', { reply: { ok: false, code: 'EDEAD', error: 'dead' } as ErrorReply }],
    ['malformed reply (no ptySock)', { reply: { ok: true, pid: 1 } as unknown as AttachReply }],
    ['malformed reply (numeric ptySock)', { reply: { ok: true, ptySock: 5432, rvSock: '', pid: 1 } as unknown as AttachReply }],
    ['attachOp throws', { attachThrows: true }],
    ['connectPty throws', { connectThrows: true }],
  ])('sends {t:unavailable} and closes on %s', async (_label, opts) => {
    const { ws, bridge } = setup(opts as any);
    bridge.handleConnection(ws, { short: 'ab12', cols: 80, rows: 24 });
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.frames()).toEqual([{ t: 'unavailable' }]);
    expect(ws.closed).toBe(true);
  });

  it('sends {t:unavailable} before close on a post-attach upstream error', async () => {
    const { ws, upstream, bridge } = setup();
    await attach(ws, upstream, bridge);
    upstream.error(new Error('reset'));
    expect(ws.frames().at(-1)).toEqual({ t: 'unavailable' });
    expect(ws.closed).toBe(true);
    expect(upstream.destroyed).toBe(true);
  });

  it('does NOT send unavailable when the upstream closes after a clean exit', async () => {
    const { ws, upstream, bridge } = setup();
    await attach(ws, upstream, bridge);
    upstream.data(encodeFrame({ t: 'exit', code: 0, signal: null }));
    ws.sent.length = 0;
    upstream.close(); // post-exit close is expected
    expect(ws.frames()).toEqual([]);
  });

  it('destroys both legs on a FrameOverflowError from the upstream', async () => {
    const { ws, upstream, bridge } = setup();
    await attach(ws, upstream, bridge);
    ws.sent.length = 0;
    upstream.data('x'.repeat((32 << 20) + 100)); // > MAX_PENDING_BYTES, no newline
    expect(ws.frames().at(-1)).toEqual({ t: 'unavailable' });
    expect(upstream.destroyed).toBe(true);
    expect(ws.closed).toBe(true);
  });
});

describe('createPtyBridge — backpressure', () => {
  it('pauses upstream at high-water and resumes below low-water without new output; cancels on teardown', async () => {
    const { ws, upstream, bridge } = setup();
    await attach(ws, upstream, bridge);
    ws.bufferedAmount = HIGH_WATER_BYTES + 1;
    upstream.data(encodeFrame({ t: 'out', b: 'AA==' })); // triggers checkBackpressure
    expect(upstream.paused).toBe(true);
    // no further upstream output — the recheck timer must resume on its own
    ws.bufferedAmount = LOW_WATER_BYTES - 1;
    await vi.advanceTimersByTimeAsync(60);
    expect(upstream.paused).toBe(false);
  });

  it('pauses reading on upstream write()=false and flushes queued stdin on drain', async () => {
    const { ws, upstream, bridge } = setup();
    await attach(ws, upstream, bridge);
    ws.msg(JSON.stringify({ t: 'take-control' }));
    upstream.written.length = 0;
    upstream.writeReturn = false; // congest
    ws.msg(JSON.stringify({ t: 'stdin', b: 'QQ==' })); // written, returns false → congested
    ws.msg(JSON.stringify({ t: 'stdin', b: 'Qg==' })); // queued (congested)
    expect(upstream.frames().filter((f) => f.t === 'stdin').length).toBe(1);
    upstream.writeReturn = true;
    upstream.drain();
    expect(upstream.frames().filter((f) => f.t === 'stdin').length).toBe(2);
  });
});

describe('createPtyBridge — lifecycle', () => {
  it('stop() tears down a pending (pre-attach) connection and flips isStopping()', async () => {
    const { ws, upstream, bridge } = setup();
    bridge.handleConnection(ws, { short: 'ab12', cols: 80, rows: 24 }); // attach not yet resolved
    expect(bridge.isStopping()).toBe(false);
    bridge.stop();
    expect(bridge.isStopping()).toBe(true);
    expect(ws.closed).toBe(true);
    // late attach callback resolves after stop — must be ignored (no upstream frames)
    await vi.advanceTimersByTimeAsync(0);
    expect(upstream.written).toEqual([]);
  });

  it('stop() tears down a connected bridge (force-terminating the ws) and is idempotent', async () => {
    const { ws, upstream, bridge } = setup();
    await attach(ws, upstream, bridge);
    bridge.stop();
    bridge.stop(); // idempotent, no throw
    expect(ws.terminated).toBe(true); // forceful, so a stuck peer can't hang stop()
    expect(upstream.destroyed).toBe(true);
  });

  it('relays two attachers independently (coexistence; last-attacher-wins is daemon-side)', async () => {
    const upstreams: FakeUpstream[] = [];
    const bridge = createPtyBridge({
      attachOp: async () => okReply,
      connectPty: () => {
        const u = new FakeUpstream();
        upstreams.push(u);
        return u;
      },
    });
    const a = new FakeWs();
    const b = new FakeWs();
    bridge.handleConnection(a, { short: 'ab12', cols: 80, rows: 24 });
    bridge.handleConnection(b, { short: 'ab12', cols: 90, rows: 30 });
    await vi.advanceTimersByTimeAsync(0);
    expect(upstreams).toHaveLength(2);
    upstreams[0].connect();
    upstreams[1].connect();
    // Each attacher receives its own upstream's output.
    upstreams[0].data(encodeFrame({ t: 'out', b: 'QQ==' }));
    upstreams[1].data(encodeFrame({ t: 'out', b: 'Qg==' }));
    expect(a.frames().filter((f) => f.t === 'out')).toEqual([{ t: 'out', b: 'QQ==' }]);
    expect(b.frames().filter((f) => f.t === 'out')).toEqual([{ t: 'out', b: 'Qg==' }]);
    // Each attacher's input goes to its own upstream (after taking control).
    a.msg(JSON.stringify({ t: 'take-control' }));
    a.msg(JSON.stringify({ t: 'stdin', b: 'QQ==' }));
    expect(upstreams[0].frames().filter((f) => f.t === 'stdin')).toEqual([{ t: 'stdin', b: 'QQ==' }]);
    expect(upstreams[1].frames().filter((f) => f.t === 'stdin')).toEqual([]);
    bridge.stop();
    expect(a.terminated && b.terminated).toBe(true);
  });

  it('rejects a new connection while stopping', async () => {
    const { bridge } = setup();
    bridge.stop();
    const ws2 = new FakeWs();
    bridge.handleConnection(ws2, { short: 'zz', cols: 80, rows: 24 });
    expect(ws2.closed).toBe(true);
  });
});
