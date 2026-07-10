// Per-session pty-host: owns a real PTY, mirrors its output into a headless
// terminal emulator (so attach can restore the *rendered screen*, not a byte
// log), and serves the pty/rv sockets with the Task 2 NDJSON frame schema in
// both directions for the whole connection lifetime (Decision 4).
//
// Everything that touches the OS is injectable (pty factory, socket bind,
// timers, persistence) so the emulator, framing, quiescence debounce, resize
// propagation, and exit path are unit-testable without a real PTY (AC-7).

import { spawn as ptySpawn } from 'node-pty';
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { captureProcessStartedAt } from '../utils/process-info.js';
import { appendTimeline as realAppendTimeline, writeJobState as realWriteJobState } from './jobs.js';
import { ensureDir0700, ptyDir, ptySockPath, rvDir, rvSockPath } from './paths.js';
import { createLineDecoder, encodeFrame, isFrameObject } from './protocol.js';
import { bindUnixSocket } from './sockets.js';
import type {
  JobState,
  PtyClientFrame,
  PtyHostFrame,
  RvFrame,
  SessionState,
  StateRecord,
} from './types.js';

const DEFAULT_SCROLLBACK = 1000;
const SNAPSHOT_IDLE_MS = 100;
const SNAPSHOT_CAP_MS = 400;

// ── PTY seam ───────────────────────────────────────────────────────────────

/** Minimal PTY surface the host relies on (node-pty's IPty is a superset). */
export interface PtyLike {
  readonly pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
  name: string;
}

export type PtyFactory = (file: string, args: string[], opts: PtySpawnOptions) => PtyLike;

const realPtyFactory: PtyFactory = (file, args, opts) => {
  const p = ptySpawn(file, args, {
    name: opts.name,
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: opts.env,
  });
  return {
    get pid() {
      return p.pid;
    },
    onData: (cb) => {
      p.onData(cb);
    },
    onExit: (cb) => {
      p.onExit(cb);
    },
    write: (d) => p.write(d),
    resize: (c, r) => p.resize(c, r),
    kill: (sig) => p.kill(sig),
  };
};

// ── Headless emulator wrapper ────────────────────────────────────────────────

export interface ScreenBuffer {
  write(data: string, cb?: () => void): void;
  resize(cols: number, rows: number): void;
  snapshot(): { data: string; cols: number; rows: number };
  dispose(): void;
}

/** Wrap @xterm/headless + SerializeAddon: mirror bytes, restore the screen. */
export function createScreenBuffer(
  cols: number,
  rows: number,
  scrollback = DEFAULT_SCROLLBACK,
): ScreenBuffer {
  const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  return {
    write: (data, cb) => term.write(data, cb),
    resize: (c, r) => term.resize(c, r),
    snapshot: () => ({ data: serializer.serialize(), cols: term.cols, rows: term.rows }),
    dispose: () => term.dispose(),
  };
}

// ── Quiescence-debounced snapshot scheduler ──────────────────────────────────

export interface SnapshotScheduler {
  /** Call on new PTY output — pushes the idle deadline (bounded by the cap). */
  bump(): void;
  cancel(): void;
}

/**
 * Fire `onFire` once the PTY has been quiet for `idleMs`, but no later than
 * `capMs` after scheduling. Full-screen TUIs repaint asynchronously after
 * SIGWINCH, so snapshotting immediately races the repaint; this waits for the
 * repaint to settle, with a hard cap so a chatty stream still snapshots.
 */
export function scheduleQuiescentSnapshot(
  onFire: () => void,
  opts: { idleMs?: number; capMs?: number } = {},
): SnapshotScheduler {
  const idleMs = opts.idleMs ?? SNAPSHOT_IDLE_MS;
  const capMs = opts.capMs ?? SNAPSHOT_CAP_MS;
  let done = false;
  let idleTimer: ReturnType<typeof setTimeout>;
  const fire = (): void => {
    if (done) return;
    done = true;
    clearTimeout(idleTimer);
    clearTimeout(capTimer);
    onFire();
  };
  idleTimer = setTimeout(fire, idleMs);
  const capTimer = setTimeout(fire, capMs);
  return {
    bump(): void {
      if (done) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(fire, idleMs);
    },
    cancel(): void {
      done = true;
      clearTimeout(idleTimer);
      clearTimeout(capTimer);
    },
  };
}

// ── Socket client wrapper ────────────────────────────────────────────────────

/** Minimal socket surface (net.Socket satisfies it; tests inject fakes). */
export interface SocketLike {
  write(data: string): void;
  on(event: 'data', cb: (chunk: Buffer | string) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  end(): void;
  destroy(): void;
}

// ── Config + deps ────────────────────────────────────────────────────────────

export interface PtyHostConfig {
  short: string;
  daemonId: string;
  agent: string;
  argv: string[]; // [file, ...args]
  cwd: string;
  cols: number;
  rows: number;
  name?: string;
  env?: Record<string, string>;
  sessionId?: string | null;
  scrollback?: number;
}

export interface PtyHostDeps {
  ptyFactory?: PtyFactory;
  bindSocket?: typeof bindUnixSocket;
  createScreen?: (cols: number, rows: number, scrollback?: number) => ScreenBuffer;
  writeJobState?: (s: JobState) => void;
  appendTimeline?: (short: string, event: { event: string; [k: string]: unknown }) => void;
  procStart?: (pid: number) => string | null;
  now?: () => number;
  idleMs?: number;
  capMs?: number;
  /** Called once the child exits and everything is torn down. */
  onExit?: (code: number) => void;
}

export interface PtyHostHandle {
  readonly pid: number;
  stop(signal?: string): void;
}

interface Client {
  socket: SocketLike;
  state: 'pending' | 'live';
  scheduler?: SnapshotScheduler;
}

function cleanEnv(env: Record<string, string> | undefined): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') base[k] = v;
  }
  return { ...base, ...(env ?? {}) };
}

function toState(exitCode: number, signal: number | undefined): SessionState {
  if (signal) return 'stopped';
  return exitCode === 0 ? 'done' : 'failed';
}

/**
 * Boot a pty-host: spawn the child on a PTY, mirror output into the emulator,
 * and serve pty/rv sockets. Resolves once both sockets are bound.
 */
export async function runPtyHost(config: PtyHostConfig, deps: PtyHostDeps = {}): Promise<PtyHostHandle> {
  const ptyFactory = deps.ptyFactory ?? realPtyFactory;
  const bindSocket = deps.bindSocket ?? bindUnixSocket;
  const createScreen = deps.createScreen ?? createScreenBuffer;
  const writeJobState = deps.writeJobState ?? realWriteJobState;
  const appendTimeline = deps.appendTimeline ?? realAppendTimeline;
  const procStart = deps.procStart ?? captureProcessStartedAt;
  const now = deps.now ?? (() => Date.now());
  const nowIso = (): string => new Date(now()).toISOString();

  const { short, daemonId } = config;
  const ptySock = ptySockPath(daemonId, short);
  const rvSock = rvSockPath(daemonId, short);
  ensureDir0700(ptyDir(daemonId));
  ensureDir0700(rvDir(daemonId));

  const [file, ...args] = config.argv;
  const screen = createScreen(config.cols, config.rows, config.scrollback);
  const pty = ptyFactory(file, args, {
    cols: config.cols,
    rows: config.rows,
    cwd: config.cwd,
    env: cleanEnv(config.env),
    name: 'xterm-256color',
  });

  let curCols = config.cols;
  let curRows = config.rows;
  let exited = false;
  const ptyClients = new Set<Client>();
  const rvClients = new Set<SocketLike>();

  const hostPid = process.pid;
  const hostPidStartedAt = procStart(hostPid);
  // Immutable session metadata, captured ONCE while the child is still alive.
  // Recomputing these at exit (as the old baseState() did) would set createdAt
  // to the exit time and pidStartedAt to null — the child is gone by then —
  // corrupting the final persisted record.
  const createdAt = nowIso();
  const childPidStartedAt = procStart(pty.pid);
  const baseState = (): JobState => ({
    short,
    agent: config.agent,
    argv: config.argv,
    cwd: config.cwd,
    name: config.name,
    state: 'working',
    pid: pty.pid,
    pidStartedAt: childPidStartedAt,
    sessionId: config.sessionId ?? null,
    cols: curCols,
    rows: curRows,
    createdAt,
    updatedAt: nowIso(),
    daemonId,
    ptySock,
    rvSock,
    hostPid,
    hostPidStartedAt,
  });

  const initial = baseState();
  writeJobState(initial);
  appendTimeline(short, { event: 'spawned', pid: pty.pid, argv: config.argv });

  const stateRecord = (state: SessionState, exitCode?: number | null, exitSignal?: number | null): StateRecord => ({
    short,
    state,
    pid: pty.pid,
    cols: curCols,
    rows: curRows,
    updatedAt: nowIso(),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(exitSignal !== undefined ? { exitSignal } : {}),
  });

  const sendPty = (client: Client, frame: PtyHostFrame): void => {
    try {
      client.socket.write(encodeFrame(frame));
    } catch {
      /* client gone; close handler will prune it */
    }
  };
  const sendRv = (socket: SocketLike, frame: RvFrame): void => {
    try {
      socket.write(encodeFrame(frame));
    } catch {
      /* client gone */
    }
  };

  // PTY output → emulator (always) + live clients as {t:'out'}; pending clients
  // are excluded (their bytes are captured by the pending snapshot instead).
  pty.onData((data: string) => {
    screen.write(data);
    const frame: PtyHostFrame = { t: 'out', b: Buffer.from(data, 'utf8').toString('base64') };
    for (const client of ptyClients) {
      if (client.state === 'live') sendPty(client, frame);
      else client.scheduler?.bump();
    }
  });

  function handleAttach(client: Client, cols: number, rows: number): void {
    // Resize FIRST so the child repaints at the new size, then wait for the
    // repaint to settle before serializing (Decision: quiescence debounce).
    applyResize(cols, rows);
    client.scheduler?.cancel();
    client.scheduler = scheduleQuiescentSnapshot(
      () => {
        const snap = screen.snapshot();
        sendPty(client, { t: 'snapshot', data: snap.data, cols: snap.cols, rows: snap.rows });
        client.state = 'live'; // synchronous: no PTY data can interleave here
      },
      { idleMs: deps.idleMs, capMs: deps.capMs },
    );
  }

  function applyResize(cols: number, rows: number): void {
    curCols = cols;
    curRows = rows;
    pty.resize(cols, rows); // last-attacher-wins
    screen.resize(cols, rows);
  }

  function handlePtyConnection(socket: SocketLike): void {
    const client: Client = { socket, state: 'pending' };
    ptyClients.add(client);
    const decoder = createLineDecoder<PtyClientFrame>();
    const prune = (): void => {
      client.scheduler?.cancel();
      ptyClients.delete(client);
    };
    socket.on('data', (chunk) => {
      let frames: PtyClientFrame[];
      try {
        frames = decoder.push(chunk);
      } catch {
        // FrameOverflowError — a peer flooding without a newline. Drop it.
        prune();
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        if (!isFrameObject(frame)) continue; // guard null/array/primitive frames
        switch (frame.t) {
          case 'attach':
            handleAttach(client, frame.cols, frame.rows);
            break;
          case 'stdin':
            pty.write(Buffer.from(frame.b, 'base64').toString('utf8'));
            break;
          case 'resize':
            applyResize(frame.cols, frame.rows);
            break;
          case 'kill':
            pty.kill(frame.sig);
            break;
        }
      }
    });
    socket.on('close', prune);
    socket.on('error', prune);
  }

  function handleRvConnection(socket: SocketLike): void {
    rvClients.add(socket);
    sendRv(socket, { t: 'state', record: stateRecord('working') });
    const prune = (): void => {
      rvClients.delete(socket);
    };
    socket.on('close', prune);
    socket.on('error', prune);
  }

  let initialized = false;
  type PendingExit = { exitCode: number; signal: number | undefined };
  let pendingExit: PendingExit | null = null;

  function finalizeExit(exitCode: number, signal: number | undefined): void {
    if (exited) return;
    exited = true;
    const state = toState(exitCode, signal);
    const snap = screen.snapshot();
    const finalState: JobState = {
      ...baseState(),
      state,
      updatedAt: nowIso(),
      exitCode,
      exitSignal: signal ?? null,
      lastScreen: snap.data,
    };
    writeJobState(finalState);
    appendTimeline(short, { event: 'exited', code: exitCode, signal: signal ?? null });

    // Notify + tear down every attached client: cancel its snapshot scheduler,
    // send the exit frame, then end() its socket so the last frame flushes
    // rather than the attacher only seeing a bare peer-close.
    const exitFrame: PtyHostFrame = { t: 'exit', code: exitCode, signal: signal ?? null };
    for (const client of ptyClients) {
      client.scheduler?.cancel();
      sendPty(client, exitFrame);
      try {
        client.socket.end();
      } catch {
        /* ignore */
      }
    }
    for (const socket of rvClients) {
      sendRv(socket, { t: 'settled', record: stateRecord(state, exitCode, signal ?? null) });
      try {
        socket.end();
      } catch {
        /* ignore */
      }
    }

    try {
      ptyServer?.close();
    } catch {
      /* ignore */
    }
    try {
      rvServer?.close();
    } catch {
      /* ignore */
    }
    screen.dispose();
    deps.onExit?.(exitCode ?? (signal ? 1 : 0));
  }

  // Register the exit listener BEFORE the first await (the socket binds). A fast
  // child (e.g. `/bin/true`) can exit before the binds resolve; node-pty does
  // not replay 'exit' to a late listener, so registering after the awaits would
  // leave state.json stuck at 'working' and the host alive forever. If the exit
  // fires before initialization completes, buffer it and replay after the binds.
  pty.onExit(({ exitCode, signal }) => {
    if (!initialized) {
      pendingExit = { exitCode, signal };
      return;
    }
    finalizeExit(exitCode, signal);
  });

  const ptyServer = await bindSocket(ptySock, (s) => handlePtyConnection(s as unknown as SocketLike));
  const rvServer = await bindSocket(rvSock, (s) => handleRvConnection(s as unknown as SocketLike));
  initialized = true;
  // Read through an assertion: TS control-flow can't see the async onExit
  // callback assign `pendingExit`, so it narrows the raw read to `null` (then
  // `never`). The assertion restores the real union so the guard type-checks.
  const buffered = pendingExit as PendingExit | null;
  if (buffered) finalizeExit(buffered.exitCode, buffered.signal);

  return {
    get pid() {
      return pty.pid;
    },
    stop(signal?: string) {
      pty.kill(signal);
    },
  };
}

// ── Smoke payload (Task 5's AC-6 gate invokes this via the linked binary) ─────

/** Allocate + immediately destroy a real PTY, proving the node-pty prebuild
 * works in this exact runtime. Prints OK and returns. */
export function smokePtyHost(deps: { ptyFactory?: PtyFactory } = {}): string {
  const ptyFactory = deps.ptyFactory ?? realPtyFactory;
  const p = ptyFactory('/bin/sh', ['-c', 'exit 0'], {
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: cleanEnv(undefined),
    name: 'xterm-256color',
  });
  const pid = p.pid;
  try {
    p.kill();
  } catch {
    /* child may have already exited */
  }
  return `OK: pty-host smoke — allocated + destroyed a PTY (pid ${pid})`;
}
