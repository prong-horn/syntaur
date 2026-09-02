/**
 * ACP client wrapper — the product form of the spike's `Harness`
 * (`scripts/spike/acp/harness.ts`), with the measurement code dropped.
 *
 * Two layers on purpose:
 *   - `connectAcpClient(stream, handlers)` is the transport-agnostic connection.
 *     Tests wire it to an in-process fake agent (`client().connect(agentApp)`),
 *     so the protocol surface is exercised without a subprocess.
 *   - `spawnAcpClient(...)` is a thin shell over it that owns a real adapter
 *     process: `detached: true` (its own process group), piped stdio, stderr into
 *     a bounded ring buffer, and a `close()` that tears the whole group down.
 *
 * Spike Decision 1: the fluent `client(...).connect(stream)` API, never
 * `connectWith` — a chat session outlives any single operation.
 *
 * Teardown is the spike's, verbatim in intent (spike Decision 8): `conn.close()`,
 * `SIGTERM` to `-pgid` with a 4 s grace, `SIGKILL` to the group if `pgrep -g`
 * still lists members, then `SIGKILL` each surviving descendant found by walking
 * `ps -axo pid,ppid,pgid`. Killing the adapter pid alone is never enough — spike
 * row 15 shows claude's `claude` child outliving a SIGKILL of the adapter.
 */

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { PassThrough, Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type { Harness } from './types.js';

/** Bytes of adapter stderr kept for diagnostics (a failed `initialize` reads it). */
const STDERR_RING_BYTES = 16 * 1024;
const SIGTERM_GRACE_MS = 4000;
const SIGKILL_GRACE_MS = 2000;

export interface AcpClientHandlers {
  onUpdate: (notification: acp.SessionNotification) => void;
  /**
   * Answer a `session/request_permission`. The broker resolves this when the
   * human clicks, when the request times out, or when the turn is cancelled.
   */
  onPermissionRequest: (
    request: acp.RequestPermissionRequest,
  ) => Promise<acp.RequestPermissionResponse>;
}

export interface AcpClient {
  /** ACP `initialize`. Resolves to the agent's capabilities + `agentInfo`. */
  initialize(): Promise<acp.InitializeResponse>;
  newSession(req: {
    cwd: string;
    mcpServers?: unknown[];
    _meta?: Record<string, unknown>;
  }): Promise<acp.NewSessionResponse>;
  resumeSession(sessionId: string, cwd: string): Promise<acp.ResumeSessionResponse>;
  loadSession(sessionId: string, cwd: string): Promise<acp.LoadSessionResponse>;
  prompt(sessionId: string, blocks: acp.ContentBlock[]): Promise<acp.PromptResponse>;
  cancel(sessionId: string): Promise<void>;
  setMode(sessionId: string, modeId: string): Promise<acp.SetSessionModeResponse>;
  setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<acp.SetSessionConfigOptionResponse>;
  /** OS pid of the adapter process; null for a transport-only (in-process) client. */
  readonly pid: number | null;
  /** Resolves when the adapter process exits; never resolves for a transport-only client. */
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Tail of the adapter's stderr (bounded). */
  stderr(): string;
  alive(): boolean;
  close(): Promise<void>;
}

/**
 * Connect a client over an arbitrary ACP `Stream` (or, in tests, straight to an
 * `AgentApp`). Owns no process — `close()` only closes the connection.
 */
export function connectAcpClient(
  target: acp.Stream | acp.AgentApp,
  handlers: AcpClientHandlers,
): AcpClient {
  const app = acp
    .client({ name: 'syntaur' })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
      handlers.onPermissionRequest(ctx.params),
    )
    .onNotification(acp.methods.client.session.update, (ctx) => {
      handlers.onUpdate(ctx.params);
    });
  // The overloads are (Stream) and (AgentApp); a union argument needs the split.
  const conn =
    target instanceof acp.AgentApp ? app.connect(target) : app.connect(target as acp.Stream);
  return makeClient(conn, { child: null, stderr: () => '' });
}

export interface SpawnAcpClientOptions extends AcpClientHandlers {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  onStderr?: (chunk: string) => void;
}

/**
 * Spawn an ACP adapter in its own process group and connect a client to it.
 * Throws synchronously only on a spawn error the OS reports immediately; a
 * missing binary surfaces on the first request as `write EPIPE`.
 */
export function spawnAcpClient(options: SpawnAcpClientOptions): AcpClient {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    // Own process group so kill(-pid) reaches grandchildren (spike Decision 8).
    detached: true,
  });

  let stderrRing = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrRing = (stderrRing + chunk).slice(-STDERR_RING_BYTES);
    options.onStderr?.(chunk);
  });
  // A spawn failure (ENOENT) arrives as an 'error' event; without a listener it
  // would take the dashboard process down.
  child.on('error', (err) => {
    stderrRing = (stderrRing + `spawn error: ${err.message}\n`).slice(-STDERR_RING_BYTES);
  });

  // The SDK consumes a web ReadableStream; a PassThrough keeps the node stream's
  // backpressure semantics intact across the conversion.
  const forSdk = new PassThrough();
  child.stdout?.pipe(forSdk);

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(forSdk) as ReadableStream<Uint8Array>,
  );

  const app = acp
    .client({ name: 'syntaur' })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
      options.onPermissionRequest(ctx.params),
    )
    .onNotification(acp.methods.client.session.update, (ctx) => {
      options.onUpdate(ctx.params);
    });

  const conn = app.connect(stream);
  return makeClient(conn, { child, stderr: () => stderrRing, onExit: options.onExit });
}

/** Command + args for a harness, ready for {@link spawnAcpClient}. */
export function harnessCommand(
  spec: { command: string; args: string[] },
  _harness?: Harness,
): { command: string; args: string[] } {
  return { command: spec.command, args: [...spec.args] };
}

// --- internals -------------------------------------------------------------

interface ProcessBinding {
  child: ChildProcess | null;
  stderr: () => string;
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
}

function makeClient(conn: acp.ClientConnection, proc: ProcessBinding): AcpClient {
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  // A transport-only client has no process to watch, so connection closure is
  // the only liveness signal it has — and the broker relies on `alive()` to
  // decide whether it must respawn and resume.
  let connectionClosed = false;
  conn.closed.then(
    () => {
      connectionClosed = true;
    },
    () => {
      connectionClosed = true;
    },
  );
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    if (!proc.child) return; // transport-only client: never exits
    proc.child.on('exit', (code, signal) => {
      exited = { code, signal };
      proc.onExit?.(exited);
      resolve(exited);
    });
  });

  const pid = proc.child?.pid ?? null;

  return {
    initialize: () =>
      conn.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        // Decision 6 / spike Decision 4: no client fs or terminal capabilities.
        clientCapabilities: {},
        clientInfo: { name: 'syntaur', version: '2' },
      } as acp.InitializeRequest),

    newSession: (req) =>
      conn.agent.request(acp.methods.agent.session.new, {
        cwd: req.cwd,
        mcpServers: req.mcpServers ?? [],
        ...(req._meta ? { _meta: req._meta } : {}),
      } as acp.NewSessionRequest),

    resumeSession: (sessionId, cwd) =>
      conn.agent.request(acp.methods.agent.session.resume, {
        sessionId,
        cwd,
        // Optional on resume, required on load; sent on both (spike Decision 7).
        mcpServers: [],
      } as acp.ResumeSessionRequest),

    loadSession: (sessionId, cwd) =>
      conn.agent.request(acp.methods.agent.session.load, {
        sessionId,
        cwd,
        mcpServers: [],
      } as acp.LoadSessionRequest),

    prompt: (sessionId, blocks) =>
      conn.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: blocks,
      } as acp.PromptRequest),

    cancel: (sessionId) => conn.agent.notify(acp.methods.agent.session.cancel, { sessionId }),

    setMode: (sessionId, modeId) =>
      conn.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId }),

    setConfigOption: (sessionId, configId, value) =>
      conn.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId,
        value,
      } as acp.SetSessionConfigOptionRequest),

    pid,
    exit,
    stderr: proc.stderr,

    alive(): boolean {
      if (connectionClosed) return false;
      if (!proc.child) return true;
      return exited === null && proc.child.exitCode === null && proc.child.signalCode === null;
    },

    async close(): Promise<void> {
      try {
        conn.close();
      } catch {
        // Already closed; the group teardown below is what matters.
      }
      connectionClosed = true;
      if (!proc.child || pid === null) return;
      if (exited !== null) return;

      // Snapshot the tree BEFORE the kill. A descendant that called setsid (or
      // was spawned `detached`) is neither in the process group nor reachable by
      // a PPID walk once the adapter is gone and it reparents to init — the only
      // moment it is findable is now.
      const known = new Map<number, string>();
      for (const d of descendants(pid)) known.set(d.pid, d.cmd);

      await killGroup(pid, exit, 'SIGTERM', SIGTERM_GRACE_MS);
      if (groupMembers(pid).length > 0) {
        await killGroup(pid, exit, 'SIGKILL', SIGKILL_GRACE_MS);
      }
      // Anything still in the group after the group kill (claude's `claude`
      // child survives a SIGKILL of the adapter pid alone — spike row 15).
      for (const d of descendants(pid)) known.set(d.pid, d.cmd);

      for (const [victim, cmd] of known) {
        if (victim === pid || victim === process.pid) continue;
        // Re-check the command name so a pid recycled during the grace window is
        // not the thing we kill.
        if (commandOf(victim) !== cmd) continue;
        try {
          process.kill(victim, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    },
  };
}

async function killGroup(
  pid: number,
  exit: Promise<unknown>,
  signal: NodeJS.Signals,
  graceMs: number,
): Promise<void> {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      return; // already dead
    }
  }
  await Promise.race([exit, sleep(graceMs)]);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

/** PIDs still alive in the process group (macOS `pgrep -g`). */
export function groupMembers(pgid: number): Array<{ pid: number; cmd: string }> {
  try {
    return execFileSync('pgrep', ['-g', String(pgid), '-l'], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [p, ...cmd] = l.trim().split(/\s+/);
        return { pid: Number(p), cmd: cmd.join(' ') };
      });
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

/** `ps -o comm=` for one pid, or null when it is gone. */
export function commandOf(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null; // ps exits 1 when the pid does not exist
  }
}

/**
 * Descendants of `pid` found by walking PPIDs — catches children that called
 * `setsid` and so left the process group, while the adapter is still alive to
 * anchor the walk. Includes `pid` itself if alive.
 */
export function descendants(pid: number): Array<{ pid: number; ppid: number; pgid: number; cmd: string }> {
  let rows: Array<{ pid: number; ppid: number; pgid: number; cmd: string }>;
  try {
    rows = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,comm='], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((l) => {
        const [p, ppid, pgid, ...cmd] = l.trim().split(/\s+/);
        return { pid: Number(p), ppid: Number(ppid), pgid: Number(pgid), cmd: cmd.join(' ') };
      });
  } catch {
    return [];
  }
  const want = new Set([pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) {
      if ((want.has(r.ppid) || r.pid === pid || r.pgid === pid) && !want.has(r.pid)) {
        want.add(r.pid);
        grew = true;
      }
    }
  }
  return rows.filter((r) => want.has(r.pid));
}

/** Adapter version string from `initialize`'s `agentInfo`, or null. */
export function adapterVersion(res: acp.InitializeResponse): string | null {
  const info = res.agentInfo as { name?: string; version?: string } | undefined;
  if (!info) return null;
  return [info.name, info.version].filter(Boolean).join('@') || null;
}
