// WebSocket ⇄ daemon pty-socket relay for browser attach (Phase D).
//
// Mirrors src/daemon/attach-client.ts minus the tty concerns: discover the
// session's pty socket via the control-plane `attach` op, connect, and pump
// NDJSON frames both ways. The browser speaks one JSON frame per ws message; the
// unix side speaks newline-framed NDJSON. The bridge invents no protocol beyond
// a single extra host→browser frame `{t:'unavailable'}` meaning "no live
// session / transport lost — refetch the detail endpoint for the settled screen".
//
// Security + robustness the reference client doesn't need:
//  - view-only by default: stdin is dropped until an in-band {t:'take-control'};
//    {t:'kill'} is never forwarded; binary ws frames are rejected.
//  - dimension validation: the daemon only type-checks resize numbers, so a
//    local token-bearing client could send 0/negative/huge dims — bound them.
//  - readiness gate: the browser ws is OPEN before the async attach/connect
//    resolves, so control intent + the latest resize are retained and post-
//    control stdin is bounded-queued until the upstream socket exists.
//  - backpressure both directions (bufferedAmount has no drain event upstream;
//    Socket.write()=false + 'drain' downstream), with a bounded input queue.
//  - a stop() lifecycle that tears down pending AND connected bridges and
//    ignores late attach/connect callbacks.

import { createLineDecoder, encodeFrame, isFrameObject } from '../daemon/protocol.js';
import type { AttachReply, ErrorReply, PtyHostFrame } from '../daemon/types.js';

// Tuning constants (exported so the server can align WebSocketServer.maxPayload).
export const MAX_COLS = 500;
export const MAX_ROWS = 300;
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
export const HIGH_WATER_BYTES = 1 << 20; // 1 MiB buffered to the browser → pause upstream
export const LOW_WATER_BYTES = 256 << 10; // 256 KiB → resume upstream
export const BACKPRESSURE_RECHECK_MS = 50;
export const INPUT_QUEUE_MAX_BYTES = 1 << 20; // bounded pre-ready + congestion stdin
export const RESIZE_DEBOUNCE_MS = 50;
export const MAX_WS_PAYLOAD_BYTES = 1 << 20; // cap one inbound ws message

/** Loopback predicate for the upgrade guard (also used by pty-upgrade-auth). */
export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** A finite safe-integer dimension within [1, max], else null. */
export function validDim(n: unknown, max: number): number | null {
  if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= max) return n;
  return null;
}

/** Minimal WebSocket surface (a subset of `ws`). */
export interface BridgeWs {
  send(data: string): void;
  close(): void;
  readonly bufferedAmount: number;
  on(event: 'message', cb: (data: unknown, isBinary: boolean) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

/** Minimal upstream unix-socket surface (a subset of net.Socket). */
export interface BridgeUpstream {
  write(data: string): boolean;
  pause(): void;
  resume(): void;
  destroy(): void;
  on(event: 'data', cb: (chunk: Buffer | string) => void): void;
  on(event: 'connect', cb: () => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'drain', cb: () => void): void;
}

export interface PtyBridgeDeps {
  /** Resolve the session's pty socket (queryDaemon({op:'attach'})). null ⇒ no
   * live daemon; a rejection is caught and treated the same. */
  attachOp: (short: string, cols: number, rows: number) => Promise<AttachReply | ErrorReply | null>;
  connectPty: (sock: string) => BridgeUpstream;
}

export interface PtyBridgeConn {
  short: string;
  cols: number;
  rows: number;
}

export interface PtyBridge {
  handleConnection(ws: BridgeWs, conn: PtyBridgeConn): void;
  stop(): void;
  isStopping(): boolean;
}

interface Conn {
  ws: BridgeWs;
  upstream: BridgeUpstream | null;
  ready: boolean;
  closed: boolean;
  exited: boolean;
  controlGranted: boolean;
  pendingControl: boolean | undefined;
  pendingResize: { cols: number; rows: number } | null;
  inputQueue: string[]; // base64 stdin payloads awaiting readiness/drain
  queuedBytes: number;
  congested: boolean; // upstream.write() returned false; awaiting 'drain'
  recheck: ReturnType<typeof setInterval> | null;
  resizeTimer: ReturnType<typeof setTimeout> | null;
  decoder: ReturnType<typeof createLineDecoder<PtyHostFrame>>;
}

function toText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return '';
}

export function createPtyBridge(deps: PtyBridgeDeps): PtyBridge {
  const connections = new Set<Conn>();
  let stopping = false;

  function safeSend(conn: Conn, data: string): void {
    try {
      conn.ws.send(data);
    } catch {
      /* ignore */
    }
  }

  function teardown(conn: Conn): void {
    if (conn.closed) return;
    conn.closed = true;
    if (conn.recheck) {
      clearInterval(conn.recheck);
      conn.recheck = null;
    }
    if (conn.resizeTimer) {
      clearTimeout(conn.resizeTimer);
      conn.resizeTimer = null;
    }
    try {
      conn.upstream?.destroy();
    } catch {
      /* ignore */
    }
    try {
      conn.ws.close();
    } catch {
      /* ignore */
    }
    connections.delete(conn);
  }

  /** No live/attachable session (attach failure OR post-attach transport loss):
   * tell the browser to refetch the detail endpoint, then close. */
  function unavailable(conn: Conn): void {
    if (conn.closed) return;
    if (!conn.exited) safeSend(conn, JSON.stringify({ t: 'unavailable' }));
    teardown(conn);
  }

  /** base64 stdin → upstream, honoring reverse backpressure + the bounded queue. */
  function writeStdin(conn: Conn, b: string): void {
    if (conn.closed || !conn.upstream) return;
    if (conn.congested) {
      queueInput(conn, b);
      return;
    }
    const ok = conn.upstream.write(encodeFrame({ t: 'stdin', b }));
    if (!ok) conn.congested = true;
  }

  function queueInput(conn: Conn, b: string): void {
    conn.queuedBytes += b.length;
    if (conn.queuedBytes > INPUT_QUEUE_MAX_BYTES) {
      unavailable(conn); // sustained congestion / pre-ready flood
      return;
    }
    conn.inputQueue.push(b);
  }

  function drainQueue(conn: Conn): void {
    const q = conn.inputQueue;
    conn.inputQueue = [];
    conn.queuedBytes = 0;
    for (const b of q) {
      if (conn.closed) return;
      writeStdin(conn, b);
    }
  }

  function scheduleResize(conn: Conn, cols: number, rows: number): void {
    if (conn.resizeTimer) clearTimeout(conn.resizeTimer);
    conn.resizeTimer = setTimeout(() => {
      conn.resizeTimer = null;
      if (conn.closed || !conn.upstream) return;
      conn.upstream.write(encodeFrame({ t: 'resize', cols, rows }));
    }, RESIZE_DEBOUNCE_MS);
  }

  function checkBackpressure(conn: Conn): void {
    if (conn.closed || !conn.upstream) return;
    if (conn.ws.bufferedAmount > HIGH_WATER_BYTES && !conn.recheck) {
      conn.upstream.pause();
      conn.recheck = setInterval(() => {
        if (conn.closed) {
          if (conn.recheck) clearInterval(conn.recheck);
          conn.recheck = null;
          return;
        }
        if (conn.ws.bufferedAmount <= LOW_WATER_BYTES) {
          if (conn.recheck) clearInterval(conn.recheck);
          conn.recheck = null;
          conn.upstream?.resume();
        }
      }, BACKPRESSURE_RECHECK_MS);
    }
  }

  function onUpstreamConnect(conn: Conn, cols: number, rows: number): void {
    if (conn.closed || !conn.upstream) return;
    conn.upstream.write(encodeFrame({ t: 'attach', cols, rows }));
    conn.ready = true;
    if (conn.pendingControl !== undefined) conn.controlGranted = conn.pendingControl;
    if (conn.pendingResize) {
      const { cols: c, rows: r } = conn.pendingResize;
      conn.pendingResize = null;
      conn.upstream.write(encodeFrame({ t: 'resize', cols: c, rows: r }));
    }
    drainQueue(conn); // queued stdin was only accepted post-take-control
  }

  function onUpstreamData(conn: Conn, chunk: Buffer | string): void {
    if (conn.closed) return;
    let frames: PtyHostFrame[];
    try {
      frames = conn.decoder.push(chunk);
    } catch {
      unavailable(conn); // FrameOverflowError — destroy both legs
      return;
    }
    for (const frame of frames) {
      if (!isFrameObject(frame)) continue;
      safeSend(conn, JSON.stringify(frame)); // snapshot/out/exit verbatim
      if (frame.t === 'exit') {
        conn.exited = true;
        teardown(conn);
        return;
      }
    }
    checkBackpressure(conn);
  }

  function onClientMessage(conn: Conn, data: unknown, isBinary: boolean): void {
    if (conn.closed) return;
    if (isBinary) return; // reject binary frames outright
    let frame: unknown;
    try {
      frame = JSON.parse(toText(data));
    } catch {
      return; // malformed → drop, never throw
    }
    if (!isFrameObject(frame)) return;
    const t = frame.t;

    if (t === 'take-control') {
      if (!conn.ready) conn.pendingControl = true;
      else conn.controlGranted = true;
      return; // control frames are stripped, never forwarded
    }
    if (t === 'release-control') {
      if (!conn.ready) conn.pendingControl = false;
      else conn.controlGranted = false;
      return;
    }
    if (t === 'kill') return; // never forwarded regardless of control

    if (t === 'resize') {
      const c = validDim(frame.cols, MAX_COLS);
      const r = validDim(frame.rows, MAX_ROWS);
      if (c === null || r === null) return; // drop invalid dims
      if (!conn.ready) {
        conn.pendingResize = { cols: c, rows: r };
        return;
      }
      scheduleResize(conn, c, r);
      return;
    }

    if (t === 'stdin') {
      if (typeof frame.b !== 'string') return;
      const granted = conn.ready ? conn.controlGranted : conn.pendingControl === true;
      if (!granted) return; // view-only gate
      if (!conn.ready) {
        queueInput(conn, frame.b);
        return;
      }
      writeStdin(conn, frame.b);
      return;
    }
    // 'attach' (bridge-owned) and any unknown type → drop
  }

  async function attachAndConnect(conn: Conn, short: string, cols: number, rows: number): Promise<void> {
    let reply: AttachReply | ErrorReply | null;
    try {
      reply = await deps.attachOp(short, cols, rows);
    } catch {
      reply = null;
    }
    if (stopping || conn.closed) return; // late callback after stop/close — ignore
    if (!reply || reply.ok !== true) {
      unavailable(conn);
      return;
    }
    let upstream: BridgeUpstream;
    try {
      upstream = deps.connectPty(reply.ptySock);
    } catch {
      unavailable(conn);
      return;
    }
    conn.upstream = upstream;
    upstream.on('connect', () => onUpstreamConnect(conn, cols, rows));
    upstream.on('data', (chunk) => onUpstreamData(conn, chunk));
    upstream.on('drain', () => {
      if (conn.closed) return;
      conn.congested = false;
      drainQueue(conn);
    });
    upstream.on('close', () => unavailable(conn));
    upstream.on('error', () => unavailable(conn));
  }

  function handleConnection(ws: BridgeWs, connInfo: PtyBridgeConn): void {
    if (stopping) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      return;
    }
    const cols = validDim(connInfo.cols, MAX_COLS) ?? DEFAULT_COLS;
    const rows = validDim(connInfo.rows, MAX_ROWS) ?? DEFAULT_ROWS;
    const conn: Conn = {
      ws,
      upstream: null,
      ready: false,
      closed: false,
      exited: false,
      controlGranted: false,
      pendingControl: undefined,
      pendingResize: null,
      inputQueue: [],
      queuedBytes: 0,
      congested: false,
      recheck: null,
      resizeTimer: null,
      decoder: createLineDecoder<PtyHostFrame>(),
    };
    connections.add(conn); // register at ENTRY so stop() tears down a pending attach

    ws.on('message', (d, isBinary) => onClientMessage(conn, d, isBinary));
    ws.on('close', () => teardown(conn));
    ws.on('error', () => teardown(conn));

    void attachAndConnect(conn, connInfo.short, cols, rows);
  }

  return {
    handleConnection,
    stop(): void {
      stopping = true;
      for (const conn of [...connections]) teardown(conn);
    },
    isStopping(): boolean {
      return stopping;
    },
  };
}
