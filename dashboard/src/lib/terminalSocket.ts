// React-free per-session pty WebSocket transport (Phase D browser attach).
//
// Talks the daemon pty frame schema verbatim (one JSON frame per ws message),
// plus the bridge's `{t:'unavailable'}`. Kept DOM-free and dependency-injected
// (ws factory + url resolver) so it is unit-testable under the node-env dashboard
// vitest config. No auto-reconnect: exit / unavailable / an unexpected transport
// close all surface through onClose(reason) so the caller can refetch the detail
// endpoint (settled/retry). `send()` throws during CONNECTING, so control intent,
// the latest resize, and typed input are retained until OPEN and flushed then in
// the order control → input → resize.

/** Host → browser frames (daemon PtyHostFrame + the bridge unavailable signal). */
export type HostFrame =
  | { t: 'snapshot'; data: string; cols: number; rows: number }
  | { t: 'out'; b: string }
  | { t: 'exit'; code: number | null; signal: number | null }
  | { t: 'unavailable' };

export type CloseReason = 'exit' | 'unavailable' | 'transport';

/** Minimal WebSocket surface (browser WebSocket or a test fake). */
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

const WS_OPEN = 1;

export interface TerminalSocketOptions {
  short: string;
  token: string;
  cols: number;
  rows: number;
  onFrame: (frame: HostFrame) => void;
  onClose: (reason: CloseReason) => void;
  /** Override for tests / non-default derivation. */
  getWsUrl?: (short: string, token: string, cols: number, rows: number) => string;
  /** Override for tests. Defaults to the global WebSocket. */
  wsFactory?: (url: string) => WsLike;
  resizeDebounceMs?: number;
  /** Bounded pre-open typed-input buffer (base64 payloads). */
  maxPendingInput?: number;
}

export interface TerminalSocket {
  /** base64-encoded stdin payload. */
  sendStdin(b64: string): void;
  sendResize(cols: number, rows: number): void;
  takeControl(): void;
  releaseControl(): void;
  close(): void;
}

/** Default ws URL derivation — mirrors dashboard/src/hooks/wsManager.ts:
 * dev dials the API port directly (only /api is proxied); prod uses the host. */
function defaultGetWsUrl(short: string, token: string, cols: number, rows: number): string {
  const loc = (globalThis as { location?: Location }).location;
  const proto = loc?.protocol === 'https:' ? 'wss:' : 'ws:';
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  const host = env.DEV ? `${loc?.hostname ?? 'localhost'}:${env.VITE_API_PORT ?? '4800'}` : (loc?.host ?? 'localhost');
  const q = `token=${encodeURIComponent(token)}&cols=${cols}&rows=${rows}`;
  return `${proto}//${host}/ws/agent-sessions/${encodeURIComponent(short)}/pty?${q}`;
}

export function createTerminalSocket(opts: TerminalSocketOptions): TerminalSocket {
  const getWsUrl = opts.getWsUrl ?? defaultGetWsUrl;
  const factory =
    opts.wsFactory ??
    ((url: string) => new (globalThis as { WebSocket: new (u: string) => WsLike }).WebSocket(url));
  const resizeDebounceMs = opts.resizeDebounceMs ?? 50;
  const maxPendingInput = opts.maxPendingInput ?? 4096;

  const url = getWsUrl(opts.short, opts.token, opts.cols, opts.rows);
  const ws = factory(url);

  let open = false;
  let closed = false;
  let pendingControl: boolean | undefined;
  let pendingResize: { cols: number; rows: number } | null = null;
  const pendingInput: string[] = [];
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;

  function rawSend(obj: unknown): void {
    if (closed) return;
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* transport gone — onclose will fire */
    }
  }

  function finish(reason: CloseReason): void {
    if (closed) return;
    closed = true;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    opts.onClose(reason);
  }

  ws.onopen = (): void => {
    if (closed) return;
    open = true;
    if (pendingControl !== undefined) rawSend({ t: pendingControl ? 'take-control' : 'release-control' });
    for (const b of pendingInput) rawSend({ t: 'stdin', b });
    pendingInput.length = 0;
    if (pendingResize) {
      rawSend({ t: 'resize', cols: pendingResize.cols, rows: pendingResize.rows });
      pendingResize = null;
    }
  };

  ws.onmessage = (ev): void => {
    if (closed) return;
    let frame: HostFrame;
    try {
      frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) as HostFrame;
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object') return;
    opts.onFrame(frame);
    if (frame.t === 'exit') finish('exit');
    else if (frame.t === 'unavailable') finish('unavailable');
  };

  ws.onclose = (): void => {
    if (closed) return;
    finish('transport'); // unexpected close (exit/unavailable already finished)
  };
  ws.onerror = (): void => {
    // onclose usually follows; drive the transition here in case it doesn't.
    if (!closed) finish('transport');
  };

  return {
    sendStdin(b64: string): void {
      if (closed) return;
      if (open && ws.readyState === WS_OPEN) rawSend({ t: 'stdin', b: b64 });
      else if (pendingInput.length < maxPendingInput) pendingInput.push(b64);
    },
    sendResize(cols: number, rows: number): void {
      if (closed) return;
      if (!open) {
        pendingResize = { cols, rows };
        return;
      }
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        rawSend({ t: 'resize', cols, rows });
      }, resizeDebounceMs);
    },
    takeControl(): void {
      if (closed) return;
      if (open) rawSend({ t: 'take-control' });
      else pendingControl = true;
    },
    releaseControl(): void {
      if (closed) return;
      if (open) rawSend({ t: 'release-control' });
      else pendingControl = false;
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}
