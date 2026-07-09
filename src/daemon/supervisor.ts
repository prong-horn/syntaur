// Daemon supervisor: a control-socket NDJSON server that dispatches, tracks,
// and mediates background pty-host sessions. pty-hosts are independent detached
// processes, so killing the daemon never kills sessions; a restarting daemon
// adopts still-live hosts from the roster and reconcile-scans beyond it.
//
// The OS-touching seams (spawn, signals, liveness, timers, socket bind, id gen,
// logging) are injectable so the op handlers, kill escalation, adoption, and
// reconcile are unit-testable without real processes or sockets. Roster/jobs/
// discovery persistence uses the real fs, redirected in tests via SYNTAUR_HOME
// and SYNTAUR_RUNTIME_DIR.

import { spawn as realSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { type Server, type Socket } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SyntaurError } from '../errors.js';
import { captureProcessStartedAt } from '../utils/process-info.js';
import {
  acquireDaemonLock,
  releaseDaemonLock,
  writeCurrentPointer,
} from './discovery.js';
import { readAllJobStates, readJobState } from './jobs.js';
import { isPidAlive as realIsPidAlive, isSameProcess } from './liveness.js';
import { appendLog } from './log.js';
import {
  controlSockPath,
  currentPointerPath,
  daemonDir,
  daemonLockPath,
  ensureDir0700,
  ptyDir,
  ptySockPath,
  rosterPath,
  runtimeBaseDir,
  rvDir,
  rvSockPath,
} from './paths.js';
import { createLineDecoder, encodeFrame } from './protocol.js';
import { adoptRoster, removeRosterEntry, upsertRosterEntry } from './roster.js';
import { bindUnixSocket, probeUnixSocket, type ProbeResult } from './sockets.js';
import type {
  ControlReply,
  ControlRequest,
  ErrorReply,
  RvFrame,
  Session,
  SessionState,
  StatusReply,
} from './types.js';

export type DaemonSpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
export type KillFn = (pid: number, signal: NodeJS.Signals | number) => void;

export interface DaemonDeps {
  spawn?: DaemonSpawnFn;
  kill?: KillFn;
  execPath?: string;
  ptyHostMainPath?: string;
  isPidAlive?: (pid: number) => boolean;
  procStart?: (pid: number) => string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  bindSocket?: typeof bindUnixSocket;
  probe?: (path: string) => Promise<ProbeResult>;
  connectPtyFrame?: (sock: string, frameLine: string) => void;
  genDaemonId?: () => string;
  genShort?: () => string;
  log?: (message: string) => void;
  /** Wait between kill-escalation stages. */
  killWaitMs?: number;
}

/** In-memory record of a session the daemon dispatched or adopted. */
interface DaemonSession {
  short: string;
  agent: string;
  argv: string[];
  cwd: string;
  name?: string;
  /** pty-host PROCESS pid (owns the sockets) — the adoption/attach liveness key. */
  hostPid: number;
  hostPidStartedAt: string | null;
  cols: number;
  rows: number;
  createdAt: string;
  ptySock: string;
  rvSock: string;
  sessionId: string | null;
}

function defaultPtyHostMainPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'pty-host-main.js');
}

function inferAgent(argv: string[]): string {
  const file = argv[0] ?? 'shell';
  return basename(file).replace(/\.(js|mjs|cjs|sh)$/, '') || 'shell';
}

export interface Daemon {
  readonly daemonId: string;
  readonly pid: number;
  start(): Promise<'started' | 'yielded'>;
  stop(): Promise<void>;
  handle(req: ControlRequest): Promise<ControlReply>;
  /** Current in-memory session count (tests). */
  readonly sessionCount: number;
  hasSession(short: string): boolean;
}

export function createDaemon(deps: DaemonDeps = {}): Daemon {
  const spawn = deps.spawn ?? (realSpawn as DaemonSpawnFn);
  const kill =
    deps.kill ??
    ((pid, sig) => {
      try {
        process.kill(pid, sig);
      } catch {
        /* already gone */
      }
    });
  const execPath = deps.execPath ?? process.execPath;
  const ptyHostMainPath = deps.ptyHostMainPath ?? defaultPtyHostMainPath();
  const isPidAlive = deps.isPidAlive ?? realIsPidAlive;
  const procStart = deps.procStart ?? captureProcessStartedAt;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const bindSocket = deps.bindSocket ?? bindUnixSocket;
  const probe = deps.probe ?? ((p) => probeUnixSocket(p));
  const genDaemonId = deps.genDaemonId ?? (() => randomBytes(4).toString('hex'));
  const genShort = deps.genShort ?? (() => randomBytes(4).toString('hex'));
  const log = deps.log ?? ((m) => appendLog(m));
  const killWaitMs = deps.killWaitMs ?? 2000;
  const liveDeps = { isPidAlive, pidStartedAt: procStart };
  const rosterDeps = { isPidAlive, pidStartedAt: procStart, now };
  const nowIso = (): string => new Date(now()).toISOString();

  const daemonId = genDaemonId();
  const sessions = new Map<string, DaemonSession>();
  let controlServer: Server | null = null;
  let startedAt = '';

  const err = (code: string, error: string): ErrorReply => ({ ok: false, code, error });

  function sessionLive(ds: DaemonSession): boolean {
    return isSameProcess(ds.hostPid, ds.hostPidStartedAt, liveDeps);
  }

  function reapSockets(ptySock: string, rvSock: string): void {
    for (const sock of [ptySock, rvSock]) {
      if (sock && existsSync(sock)) {
        try {
          unlinkSync(sock);
        } catch {
          /* best-effort */
        }
      }
    }
  }

  function toSession(ds: DaemonSession): Session {
    const live = sessionLive(ds);
    const js = readJobState(ds.short);
    const state: SessionState = live ? (js?.state ?? 'working') : (js?.state ?? 'stopped');
    return {
      short: ds.short,
      agent: ds.agent,
      argv: ds.argv,
      cwd: ds.cwd,
      name: ds.name,
      state,
      pid: js?.pid ?? ds.hostPid,
      pidStartedAt: js?.pidStartedAt ?? ds.hostPidStartedAt,
      sessionId: ds.sessionId,
      cols: js?.cols ?? ds.cols,
      rows: js?.rows ?? ds.rows,
      createdAt: ds.createdAt,
      ...(js?.exitCode !== undefined ? { exitCode: js.exitCode } : {}),
      ...(js?.exitSignal !== undefined ? { exitSignal: js.exitSignal } : {}),
    };
  }

  function allocateShort(): string {
    for (let i = 0; i < 10; i += 1) {
      const s = genShort();
      if (!sessions.has(s)) return s;
    }
    throw new SyntaurError('Could not allocate a unique session id.', {
      remediation: 'Retry; if it persists the short-id generator is degenerate.',
    });
  }

  // ── op handlers ─────────────────────────────────────────────────────────

  function dispatch(req: Extract<ControlRequest, { op: 'dispatch' }>): ControlReply {
    if (!Array.isArray(req.argv) || req.argv.length === 0) {
      return err('EEMPTYARGV', 'dispatch requires a non-empty argv');
    }
    const short = allocateShort();
    const cols = req.cols ?? 80;
    const rows = req.rows ?? 24;
    const agent = req.agent ?? inferAgent(req.argv);
    const ptySock = ptySockPath(daemonId, short);
    const rvSock = rvSockPath(daemonId, short);

    const args = [
      ptyHostMainPath,
      '--short',
      short,
      '--daemon-id',
      daemonId,
      '--agent',
      agent,
      '--cwd',
      req.cwd,
      '--cols',
      String(cols),
      '--rows',
      String(rows),
      ...(req.name ? ['--name', req.name] : []),
      ...(req.sessionId ? ['--session-id', req.sessionId] : []),
      '--',
      ...req.argv,
    ];
    const child = spawn(execPath, args, {
      detached: true,
      stdio: 'ignore',
      cwd: req.cwd,
      env: { ...process.env, ...(req.env ?? {}) },
    });
    child.unref?.();

    const hostPid = child.pid ?? -1;
    const hostPidStartedAt = procStart(hostPid);
    const createdAt = nowIso();
    const ds: DaemonSession = {
      short,
      agent,
      argv: req.argv,
      cwd: req.cwd,
      name: req.name,
      hostPid,
      hostPidStartedAt,
      cols,
      rows,
      createdAt,
      ptySock,
      rvSock,
      sessionId: req.sessionId ?? null,
    };
    sessions.set(short, ds);
    upsertRosterEntry(
      { short, pid: hostPid, pidStartedAt: hostPidStartedAt, ptySock, rvSock, agent, cwd: req.cwd, createdAt },
      daemonId,
      rosterPath(),
      rosterDeps,
    );
    log(`dispatch ${short} agent=${agent} hostPid=${hostPid} argv=${JSON.stringify(req.argv)}`);
    return { ok: true, short, pid: hostPid };
  }

  function list(): ControlReply {
    return { ok: true, sessions: [...sessions.values()].map(toSession) };
  }

  function attach(req: Extract<ControlRequest, { op: 'attach' }>): ControlReply {
    const ds = sessions.get(req.short);
    if (!ds) return err('ENOSESSION', `no session ${req.short}`);
    if (!sessionLive(ds)) return err('EDEAD', `session ${req.short} is not live`);
    return { ok: true, ptySock: ds.ptySock, rvSock: ds.rvSock, pid: ds.hostPid };
  }

  async function escalateKill(pid: number): Promise<void> {
    kill(pid, 'SIGINT');
    if (!isPidAlive(pid)) return;
    await sleep(killWaitMs);
    if (!isPidAlive(pid)) return;
    kill(pid, 'SIGTERM');
    await sleep(killWaitMs);
    if (!isPidAlive(pid)) return;
    kill(pid, 'SIGKILL');
  }

  async function killSession(req: Extract<ControlRequest, { op: 'kill' }>): Promise<ControlReply> {
    const ds = sessions.get(req.short);
    if (!ds) return err('ENOSESSION', `no session ${req.short}`);
    if (req.sig) {
      kill(ds.hostPid, req.sig as NodeJS.Signals);
    } else {
      await escalateKill(ds.hostPid);
    }
    sessions.delete(req.short);
    removeRosterEntry(req.short, daemonId, rosterPath(), rosterDeps);
    reapSockets(ds.ptySock, ds.rvSock);
    log(`kill ${req.short} hostPid=${ds.hostPid} sig=${req.sig ?? 'escalate'}`);
    return { ok: true };
  }

  function resize(req: Extract<ControlRequest, { op: 'resize' }>): ControlReply {
    const ds = sessions.get(req.short);
    if (!ds) return err('ENOSESSION', `no session ${req.short}`);
    const line = encodeFrame({ t: 'resize', cols: req.cols, rows: req.rows });
    if (deps.connectPtyFrame) deps.connectPtyFrame(ds.ptySock, line);
    else sendPtyFrame(ds.ptySock, line);
    return { ok: true };
  }

  function status(): StatusReply {
    return {
      ok: true,
      daemonId,
      pid: process.pid,
      startedAt,
      sessions: [...sessions.values()].map(toSession),
    };
  }

  async function handle(req: ControlRequest): Promise<ControlReply> {
    switch (req.op) {
      case 'dispatch':
        return dispatch(req);
      case 'list':
        return list();
      case 'kill':
        return killSession(req);
      case 'attach':
        return attach(req);
      case 'resize':
        return resize(req);
      case 'status':
        return status();
      case 'stop':
        return { ok: true };
      case 'subscribe':
        return { ok: true };
      default:
        return err('EUNKNOWNOP', `unknown op`);
    }
  }

  // ── startup ────────────────────────────────────────────────────────────

  function adoptFromRoster(): void {
    const result = adoptRoster(rosterPath(), daemonId, rosterDeps);
    for (const e of result.adopted) {
      const js = readJobState(e.short);
      sessions.set(e.short, {
        short: e.short,
        agent: e.agent,
        argv: js?.argv ?? [],
        cwd: e.cwd,
        name: js?.name,
        hostPid: e.pid,
        hostPidStartedAt: e.pidStartedAt,
        cols: js?.cols ?? 80,
        rows: js?.rows ?? 24,
        createdAt: e.createdAt,
        ptySock: e.ptySock,
        rvSock: e.rvSock,
        sessionId: js?.sessionId ?? null,
      });
    }
    log(`adopt: adopted=${result.adopted.length} dropped=${result.dropped.length}`);
  }

  /** Scan job state.json beyond the roster: adopt live hosts (pid + socket
   * probe), reap dead ones. Handles a live host whose roster entry was lost. */
  async function reconcileScan(): Promise<void> {
    for (const js of readAllJobStates()) {
      if (sessions.has(js.short)) continue;
      const pidLive = isSameProcess(js.hostPid, js.hostPidStartedAt, liveDeps);
      const sockLive = pidLive && (await probe(js.ptySock)) === 'live';
      if (pidLive && sockLive) {
        sessions.set(js.short, {
          short: js.short,
          agent: js.agent,
          argv: js.argv,
          cwd: js.cwd,
          name: js.name,
          hostPid: js.hostPid,
          hostPidStartedAt: js.hostPidStartedAt,
          cols: js.cols,
          rows: js.rows,
          createdAt: js.createdAt,
          ptySock: js.ptySock,
          rvSock: js.rvSock,
          sessionId: js.sessionId,
        });
        upsertRosterEntry(
          {
            short: js.short,
            pid: js.hostPid,
            pidStartedAt: js.hostPidStartedAt,
            ptySock: js.ptySock,
            rvSock: js.rvSock,
            agent: js.agent,
            cwd: js.cwd,
            createdAt: js.createdAt,
          },
          daemonId,
          rosterPath(),
          rosterDeps,
        );
        log(`reconcile: adopted ${js.short} (missing from roster)`);
      } else {
        reapSockets(js.ptySock, js.rvSock);
        log(`reconcile: reaped ${js.short} (dead host)`);
      }
    }
  }

  async function start(): Promise<'started' | 'yielded'> {
    ensureDir0700(runtimeBaseDir());
    const procStartSelf = procStart(process.pid);
    const acquired = acquireDaemonLock(
      { pid: process.pid, procStart: procStartSelf, daemonId },
      daemonLockPath(),
      liveDeps,
    );
    if (!acquired) {
      log('startup: lock held by a live daemon — yielding');
      return 'yielded';
    }

    ensureDir0700(daemonDir(daemonId));
    ensureDir0700(ptyDir(daemonId));
    ensureDir0700(rvDir(daemonId));

    const controlSock = controlSockPath(daemonId);
    try {
      controlServer = await bindSocket(controlSock, (s) => handleConnection(s as unknown as Socket));
    } catch (e) {
      if (e instanceof SyntaurError) {
        // Another daemon owns control.sock despite the lock — release and yield.
        releaseDaemonLock(daemonId, daemonLockPath(), liveDeps);
        log('startup: control.sock owned by a live daemon — yielding');
        return 'yielded';
      }
      throw e;
    }

    writeCurrentPointer(
      { daemonId, controlSock, pid: process.pid, procStart: procStartSelf },
      currentPointerPath(),
    );
    adoptFromRoster();
    await reconcileScan();
    startedAt = nowIso();
    log(`started daemon ${daemonId} pid=${process.pid}`);
    return 'started';
  }

  async function stop(): Promise<void> {
    if (controlServer) {
      const srv = controlServer;
      controlServer = null;
      await new Promise<void>((r) => srv.close(() => r()));
    }
    releaseDaemonLock(daemonId, daemonLockPath(), liveDeps);
    try {
      unlinkSync(currentPointerPath());
    } catch {
      /* already gone */
    }
    log(`stopped daemon ${daemonId}`);
  }

  // ── socket transport ───────────────────────────────────────────────────

  function sendPtyFrame(sock: string, frameLine: string): void {
    // Fire-and-forget connect + write; the pty-host applies the frame. Never
    // proxies bytes through control.sock (Decision 6) — this is a direct hop.
    void import('node:net').then(({ connect }) => {
      try {
        const c = connect(sock, () => {
          c.write(frameLine);
          c.end();
        });
        c.on('error', () => {
          /* host gone */
        });
      } catch {
        /* ignore */
      }
    });
  }

  function handleSubscribe(socket: Socket, req: Extract<ControlRequest, { op: 'subscribe' }>): void {
    const ds = sessions.get(req.short);
    socket.write(encodeFrame(ds ? { ok: true } : err('ENOSESSION', `no session ${req.short}`)));
    if (!ds) return;
    void import('node:net').then(({ connect }) => {
      const rv = connect(ds.rvSock, () => {});
      const decoder = createLineDecoder<RvFrame>();
      rv.on('data', (chunk) => {
        for (const frame of decoder.push(chunk)) {
          socket.write(encodeFrame({ ok: true, record: frame.record }));
        }
      });
      rv.on('error', () => {});
      socket.on('close', () => rv.destroy());
    });
  }

  function handleConnection(socket: Socket): void {
    const decoder = createLineDecoder<ControlRequest>();
    socket.on('data', (chunk: Buffer | string) => {
      void (async () => {
        for (const req of decoder.push(chunk)) {
          if (req.op === 'subscribe') {
            handleSubscribe(socket, req);
            continue;
          }
          const reply = await handle(req);
          socket.write(encodeFrame(reply));
          if (req.op === 'stop') {
            await stop();
          }
        }
      })();
    });
    socket.on('error', () => {});
  }

  return {
    daemonId,
    get pid() {
      return process.pid;
    },
    start,
    stop,
    handle,
    get sessionCount() {
      return sessions.size;
    },
    hasSession: (short) => sessions.has(short),
  };
}
