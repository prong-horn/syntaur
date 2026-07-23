import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTerminalSocket, type HostFrame, type CloseReason, type WsLike } from '../terminalSocket';

class FakeWebSocket implements WsLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0; // CONNECTING
  sent: string[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(d: string): void {
    if (this.readyState !== 1) throw new Error('WebSocket is not OPEN');
    this.sent.push(d);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  message(data: unknown): void {
    this.onmessage?.({ data });
  }
  emitClose(): void {
    this.onclose?.({});
  }
  frames(): any[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

function make(over: Partial<Parameters<typeof createTerminalSocket>[0]> = {}) {
  const frames: HostFrame[] = [];
  const closes: CloseReason[] = [];
  const sock = createTerminalSocket({
    short: 'ab12',
    token: 'tok',
    cols: 100,
    rows: 30,
    onFrame: (f) => frames.push(f),
    onClose: (r) => closes.push(r),
    wsFactory: (url) => new FakeWebSocket(url),
    ...over,
  });
  const ws = FakeWebSocket.instances.at(-1)!;
  return { sock, ws, frames, closes };
}

beforeEach(() => {
  FakeWebSocket.instances.length = 0;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('createTerminalSocket', () => {
  it('encodes the initial cols/rows into the ws URL', () => {
    const { ws } = make();
    expect(ws.url).toContain('/ws/agent-sessions/ab12/pty');
    expect(ws.url).toContain('cols=100&rows=30');
    expect(ws.url).toContain('token=tok');
  });

  it('does not throw when take-control + resize are issued while CONNECTING, flushing on open (control before resize)', () => {
    const { sock, ws } = make();
    expect(ws.readyState).toBe(0);
    expect(() => {
      sock.takeControl();
      sock.sendResize(120, 40);
      sock.sendStdin('QQ==');
    }).not.toThrow();
    expect(ws.sent).toEqual([]); // nothing sent while connecting
    ws.open();
    const frames = ws.frames();
    expect(frames[0]).toEqual({ t: 'take-control' });
    expect(frames).toContainEqual({ t: 'stdin', b: 'QQ==' });
    expect(frames).toContainEqual({ t: 'resize', cols: 120, rows: 40 });
    const controlIdx = frames.findIndex((f) => f.t === 'take-control');
    const resizeIdx = frames.findIndex((f) => f.t === 'resize');
    expect(controlIdx).toBeLessThan(resizeIdx);
  });

  it('parses host frames and forwards them to onFrame', () => {
    const { ws, frames } = make();
    ws.open();
    ws.message(JSON.stringify({ t: 'snapshot', data: 'hi', cols: 100, rows: 30 }));
    ws.message(JSON.stringify({ t: 'out', b: 'AA==' }));
    expect(frames).toEqual([
      { t: 'snapshot', data: 'hi', cols: 100, rows: 30 },
      { t: 'out', b: 'AA==' },
    ]);
  });

  it('debounces resize after open', () => {
    const { sock, ws } = make({ resizeDebounceMs: 50 });
    ws.open();
    sock.sendResize(80, 24);
    sock.sendResize(90, 25); // supersedes
    expect(ws.frames().filter((f) => f.t === 'resize')).toEqual([]);
    vi.advanceTimersByTime(51);
    expect(ws.frames().filter((f) => f.t === 'resize')).toEqual([{ t: 'resize', cols: 90, rows: 25 }]);
  });

  it('fires onClose("exit") on an exit frame and does not reconnect', () => {
    const { ws, frames, closes } = make();
    ws.open();
    ws.message(JSON.stringify({ t: 'exit', code: 0, signal: null }));
    expect(frames.at(-1)).toEqual({ t: 'exit', code: 0, signal: null });
    expect(closes).toEqual(['exit']);
    expect(FakeWebSocket.instances.length).toBe(1); // no reconnect
  });

  it('fires onClose("unavailable") on an unavailable frame', () => {
    const { ws, closes } = make();
    ws.open();
    ws.message(JSON.stringify({ t: 'unavailable' }));
    expect(closes).toEqual(['unavailable']);
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it('fires onClose("transport") on an unexpected socket close', () => {
    const { ws, closes } = make();
    ws.open();
    ws.emitClose();
    expect(closes).toEqual(['transport']);
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it('does not double-fire onClose (exit then a trailing socket close)', () => {
    const { ws, closes } = make();
    ws.open();
    ws.message(JSON.stringify({ t: 'exit', code: 1, signal: null }));
    ws.emitClose(); // trailing close after exit — must be ignored
    expect(closes).toEqual(['exit']);
  });
});
