// Attach client: discover a session's pty socket via the control-plane `attach`
// op (Decision 6 — the daemon validates + returns socket paths; bytes never
// proxy through control.sock), connect, restore the snapshot, then pipe bytes
// both ways as NDJSON frames.
//
// The hard requirement is terminal hygiene: ONE shared restore path runs on
// EVERY exit (clean detach, {t:'exit'} frame, connect failure, mid-session
// socket close, and SIGINT/SIGTERM/SIGHUP) — it drops raw mode, restores the
// saved `stty -g`, emits reset sequences (mouse off, bracketed-paste off, leave
// alt-screen, show cursor), and removes every listener. Like runTmuxAttach, it
// NEVER rejects — it always resolves an AttachResult so a caller's cleanup runs.

import { encodeFrame, createLineDecoder } from './protocol.js';
import type { AttachReply, ErrorReply, PtyHostFrame } from './types.js';

/** Reset sequences written on teardown so no raw/alt-screen/mouse state leaks. */
const RESET_SEQUENCES =
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l' + // mouse tracking off
  '\x1b[?2004l' + // bracketed paste off
  '\x1b[?1049l' + // leave alt-screen
  '\x1b[?25h'; // show cursor

export type AttachReason = 'exit' | 'detach' | 'socket-closed' | 'connect-failed' | 'signal';

export interface AttachResult {
  reason: AttachReason;
  code: number | null;
  signal: number | null;
  /** True when the user left a still-running session (vs the child exiting). */
  detached: boolean;
  error?: Error;
}

export interface AttachSocket {
  write(data: string): void;
  on(event: 'data', cb: (chunk: Buffer | string) => void): void;
  on(event: 'connect', cb: () => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  destroy(): void;
}

export interface AttachStdin {
  on(event: 'data', cb: (chunk: Buffer | string) => void): void;
  removeListener(event: 'data', cb: (chunk: Buffer | string) => void): void;
  resume(): void;
  pause(): void;
}

export interface AttachStdout {
  write(data: string | Buffer): void;
  readonly columns?: number;
  readonly rows?: number;
}

export interface SignalHub {
  on(signal: string, cb: () => void): void;
  off(signal: string, cb: () => void): void;
}

export interface AttachOptions {
  short: string;
  cols: number;
  rows: number;
}

export interface AttachDeps {
  attachOp: (short: string, cols: number, rows: number) => Promise<AttachReply | ErrorReply>;
  connectPty: (sock: string) => AttachSocket;
  stdin?: AttachStdin;
  stdout?: AttachStdout;
  signals?: SignalHub;
  captureStty?: () => string | null;
  restoreStty?: (saved: string) => void;
  setRawMode?: (on: boolean) => void;
  getSize?: () => { cols: number; rows: number };
  resizeDebounceMs?: number;
}

const DETACH_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Attach to a session's pty. Never rejects — always resolves an AttachResult,
 * and always runs the shared restore path first.
 */
export function runAttachClient(opts: AttachOptions, deps: AttachDeps): Promise<AttachResult> {
  const stdin = deps.stdin ?? (process.stdin as unknown as AttachStdin);
  const stdout = deps.stdout ?? (process.stdout as unknown as AttachStdout);
  const signals = deps.signals ?? {
    on: (s, cb) => process.on(s as NodeJS.Signals, cb),
    off: (s, cb) => process.off(s as NodeJS.Signals, cb),
  };
  const setRawMode =
    deps.setRawMode ??
    ((on: boolean) => (process.stdin as NodeJS.ReadStream).setRawMode?.(on));
  const getSize =
    deps.getSize ?? (() => ({ cols: stdout.columns ?? opts.cols, rows: stdout.rows ?? opts.rows }));
  const resizeDebounceMs = deps.resizeDebounceMs ?? 50;

  return new Promise<AttachResult>((resolvePromise) => {
    const savedStty = deps.captureStty ? deps.captureStty() : null;
    let restored = false;
    let socket: AttachSocket | null = null;
    let dataHandler: ((chunk: Buffer | string) => void) | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const registered: [string, () => void][] = [];

    function restore(): void {
      if (restored) return;
      restored = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      for (const [sig, h] of registered) {
        try {
          signals.off(sig, h);
        } catch {
          /* ignore */
        }
      }
      if (dataHandler) {
        try {
          stdin.removeListener('data', dataHandler);
        } catch {
          /* ignore */
        }
      }
      try {
        setRawMode(false);
      } catch {
        /* ignore */
      }
      if (savedStty !== null && deps.restoreStty) {
        try {
          deps.restoreStty(savedStty);
        } catch {
          /* ignore */
        }
      }
      try {
        stdout.write(RESET_SEQUENCES);
      } catch {
        /* ignore */
      }
      try {
        stdin.pause();
      } catch {
        /* ignore */
      }
      try {
        socket?.destroy();
      } catch {
        /* ignore */
      }
    }

    let settled = false;
    function settle(result: AttachResult): void {
      if (settled) return;
      settled = true;
      restore();
      resolvePromise(result);
    }

    function scheduleResize(): void {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const size = getSize();
        socket?.write(encodeFrame({ t: 'resize', cols: size.cols, rows: size.rows }));
      }, resizeDebounceMs);
    }

    function onConnect(sock: AttachSocket): void {
      sock.write(encodeFrame({ t: 'attach', cols: opts.cols, rows: opts.rows }));
      try {
        setRawMode(true);
      } catch {
        /* ignore */
      }
      stdin.resume();

      dataHandler = (chunk) =>
        sock.write(encodeFrame({ t: 'stdin', b: Buffer.from(chunk).toString('base64') }));
      stdin.on('data', dataHandler);

      const winch = (): void => scheduleResize();
      signals.on('SIGWINCH', winch);
      registered.push(['SIGWINCH', winch]);

      for (const sig of DETACH_SIGNALS) {
        const handler = (): void =>
          settle({ reason: 'signal', code: null, signal: null, detached: true });
        signals.on(sig, handler);
        registered.push([sig, handler]);
      }
    }

    deps
      .attachOp(opts.short, opts.cols, opts.rows)
      .then((reply) => {
        if (!reply.ok) {
          settle({
            reason: 'connect-failed',
            code: null,
            signal: null,
            detached: false,
            error: new Error(reply.error),
          });
          return;
        }

        socket = deps.connectPty(reply.ptySock);
        const decoder = createLineDecoder<PtyHostFrame>();

        socket.on('error', (err) =>
          settle({ reason: 'connect-failed', code: null, signal: null, detached: false, error: err }),
        );
        socket.on('connect', () => onConnect(socket as AttachSocket));
        socket.on('data', (chunk) => {
          for (const frame of decoder.push(chunk)) {
            if (frame.t === 'snapshot') {
              stdout.write(frame.data);
            } else if (frame.t === 'out') {
              stdout.write(Buffer.from(frame.b, 'base64'));
            } else if (frame.t === 'exit') {
              const suffix = frame.code != null ? ` (${frame.code})` : '';
              stdout.write(`\r\n[session exited${suffix}]\r\n`);
              settle({ reason: 'exit', code: frame.code, signal: frame.signal, detached: false });
            }
          }
        });
        socket.on('close', () =>
          settle({ reason: 'socket-closed', code: null, signal: null, detached: false }),
        );
      })
      .catch((err: unknown) =>
        settle({
          reason: 'connect-failed',
          code: null,
          signal: null,
          detached: false,
          error: err instanceof Error ? err : new Error(String(err)),
        }),
      );
  });
}
