// Shared type model for the agent-multiplexer daemon (Phase A).
//
// Covers the session model (design doc §3.1), the control-plane and pty-socket
// wire schemas (NDJSON, both discriminated unions), the roster + jobs state.json
// shapes, and the discovery records. Phase A persists ONLY jobs state.json + the
// roster (Decision 2); `sessionId` is carried nullable/reserved so the Phase B
// session-db join is a pure join, not a migration.

/** Lifecycle state of a background session (design doc §3.1). */
export type SessionState = 'working' | 'blocked' | 'done' | 'failed' | 'stopped';

/** Canonical session record surfaced by `list` / `status`. */
export interface Session {
  /** Short opaque id, unique per daemon (allocated at dispatch). */
  short: string;
  /** Agent kind: 'claude' | 'codex' | 'pi' | a bare shell, etc. */
  agent: string;
  /** Verbatim argv handed to node-pty. */
  argv: string[];
  /** Working directory the pty child was spawned in. */
  cwd: string;
  /** Optional friendly name from `bg --name`. */
  name?: string;
  state: SessionState;
  pid: number;
  /** `ps -o lstart=` string captured at spawn; the PID-recycle guard. */
  pidStartedAt: string | null;
  /** Reserved for the Phase B session-db join; always null in Phase A. */
  sessionId: string | null;
  cols: number;
  rows: number;
  createdAt: string;
  exitCode?: number | null;
  exitSignal?: number | null;
}

/** On-disk `~/.syntaur/jobs/<short>/state.json` shape (Decision 2). */
export interface JobState extends Session {
  updatedAt: string;
  daemonId: string;
  ptySock: string;
  rvSock: string;
  /**
   * PID of the pty-host PROCESS (owns the sockets, survives daemon restarts) —
   * distinct from `pid`, the agent/child pid node-pty reports. Adoption and the
   * reconcile-scan verify liveness against this, not `pid`.
   */
  hostPid: number;
  hostPidStartedAt: string | null;
  /** Serialized final screen, written on child exit for post-mortem. */
  lastScreen?: string | null;
}

/** One line appended to `~/.syntaur/jobs/<short>/timeline.jsonl`. */
export interface TimelineEvent {
  at: string;
  event: string;
  [key: string]: unknown;
}

/** A live pty-host tracked in the daemon roster. */
export interface RosterEntry {
  short: string;
  pid: number;
  pidStartedAt: string | null;
  ptySock: string;
  rvSock: string;
  agent: string;
  cwd: string;
  createdAt: string;
}

export interface RosterFile {
  daemonId: string;
  updatedAt: string;
  entries: RosterEntry[];
}

// ── Discovery records (Decision 5) ────────────────────────────────────────

/** Contents of `/tmp/syntaur-<uid>/daemon.lock` (exclusive-create). */
export interface DaemonLock {
  pid: number;
  procStart: string | null;
  daemonId: string;
}

/** Contents of `/tmp/syntaur-<uid>/current.json`, written after control.sock binds. */
export interface CurrentPointer {
  daemonId: string;
  controlSock: string;
  pid: number;
  procStart: string | null;
}

// ── control.sock wire schema (one NDJSON object per line) ──────────────────

export type ControlRequest =
  | {
      op: 'dispatch';
      argv: string[];
      cwd: string;
      name?: string;
      env?: Record<string, string>;
      agent?: string;
      cols?: number;
      rows?: number;
      sessionId?: string;
    }
  | { op: 'list' }
  | { op: 'kill'; short: string; sig?: string }
  | { op: 'attach'; short: string; cols: number; rows: number }
  | { op: 'resize'; short: string; cols: number; rows: number }
  | { op: 'subscribe'; short: string }
  | { op: 'status' }
  | { op: 'stop' };

export type ControlOp = ControlRequest['op'];

/** State record streamed over the rv socket and the `subscribe` op. */
export interface StateRecord {
  short: string;
  state: SessionState;
  pid: number;
  cols: number;
  rows: number;
  updatedAt: string;
  exitCode?: number | null;
  exitSignal?: number | null;
}

export interface ErrorReply {
  ok: false;
  code: string;
  error: string;
}
export interface DispatchReply {
  ok: true;
  short: string;
  pid: number;
}
export interface ListReply {
  ok: true;
  sessions: Session[];
}
export interface OkReply {
  ok: true;
}
export interface AttachReply {
  ok: true;
  ptySock: string;
  rvSock: string;
  pid: number;
}
export interface StatusReply {
  ok: true;
  daemonId: string;
  pid: number;
  startedAt: string;
  sessions: Session[];
}
/** One streamed frame of the `subscribe` op (after the initial OkReply). */
export interface SubscribeStateReply {
  ok: true;
  record: StateRecord;
}

export type ControlReply =
  | DispatchReply
  | ListReply
  | OkReply
  | AttachReply
  | StatusReply
  | SubscribeStateReply
  | ErrorReply;

// ── pty/<short>.sock frame schema (NDJSON both directions, whole lifetime) ──
// Decision 4: no mode switch, no raw phase — framing for the entire connection.

/** Frames sent by an attaching client to the pty-host. */
export type PtyClientFrame =
  | { t: 'attach'; cols: number; rows: number }
  | { t: 'stdin'; b: string } // base64
  | { t: 'resize'; cols: number; rows: number }
  | { t: 'kill'; sig?: string };

/** Frames sent by the pty-host to attached clients. */
export type PtyHostFrame =
  | { t: 'snapshot'; data: string; cols: number; rows: number }
  | { t: 'out'; b: string } // base64
  | { t: 'exit'; code: number | null; signal: number | null };

/** Frames on the rv/<short>.sock (structured state, no bytes). */
export type RvFrame =
  | { t: 'state'; record: StateRecord }
  | { t: 'settled'; record: StateRecord };
