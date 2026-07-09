// Control-socket client + on-demand daemon auto-start.
//
// ensureDaemon() resolves the live daemon via current.json (connect-probe); on
// miss it spawns `syntaur daemon run` detached and polls until the winner's
// control.sock accepts (the Decision 5 contention-loser wait), erroring with
// remediation on timeout. On macOS the spawn is wrapped in `launchctl asuser`
// so the daemon lands in the GUI session and survives terminal/SSH close —
// mirroring Claude Code (design doc §3.5), NOT the LaunchAgent mechanism in
// src/schedules/launchd.ts.

import { connect, type Socket } from 'node:net';
import { execFile, spawn as childSpawn } from 'node:child_process';
import { SyntaurError } from '../errors.js';
import { resolveDaemon, waitForDaemon } from './discovery.js';
import { cliEntryPath, currentPointerPath } from './paths.js';
import { createLineDecoder, encodeFrame } from './protocol.js';
import { probeUnixSocket, type ProbeResult } from './sockets.js';
import type { DaemonSpawnFn } from './supervisor.js';
import type { ControlReply, ControlRequest, CurrentPointer } from './types.js';

/** Runs a command to completion, resolving its exit code (any failure ⇒ 1). */
export type ExecFn = (command: string, args: string[], timeoutMs: number) => Promise<{ code: number }>;

const realExec: ExecFn = (command, args, timeoutMs) =>
  new Promise((resolvePromise) => {
    execFile(command, args, { timeout: timeoutMs }, (err) => {
      resolvePromise({ code: err ? 1 : 0 });
    });
  });

const realSpawn: DaemonSpawnFn = (command, args, options) => childSpawn(command, args, options);

export interface ClientDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  probe?: (path: string) => Promise<ProbeResult>;
  readFile?: (path: string) => string | null;
  spawn?: DaemonSpawnFn;
  exec?: ExecFn;
  sendRequest?: (controlSock: string, req: ControlRequest, timeoutMs?: number) => Promise<ControlReply>;
  execPath?: string;
  cliEntryPath?: string;
  platform?: NodeJS.Platform;
  uid?: number;
  launchctlTimeoutMs?: number;
  waitTimeoutMs?: number;
  waitIntervalMs?: number;
}

interface ResolvedClientDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  probe: (path: string) => Promise<ProbeResult>;
  readFile?: (path: string) => string | null;
  spawn: DaemonSpawnFn;
  exec: ExecFn;
  execPath: string;
  cliEntryPath: string;
  platform: NodeJS.Platform;
  uid: number;
  launchctlTimeoutMs: number;
  waitTimeoutMs: number;
  waitIntervalMs: number;
}

function resolveDeps(deps: ClientDeps): ResolvedClientDeps {
  return {
    now: deps.now ?? (() => Date.now()),
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    probe: deps.probe ?? ((p) => probeUnixSocket(p)),
    readFile: deps.readFile,
    spawn: deps.spawn ?? realSpawn,
    exec: deps.exec ?? realExec,
    execPath: deps.execPath ?? process.execPath,
    cliEntryPath: deps.cliEntryPath ?? cliEntryPath(),
    platform: deps.platform ?? process.platform,
    uid: deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0),
    launchctlTimeoutMs: deps.launchctlTimeoutMs ?? 5000,
    waitTimeoutMs: deps.waitTimeoutMs ?? 5000,
    waitIntervalMs: deps.waitIntervalMs ?? 100,
  };
}

/** Build the detached daemon spawn, wrapping in launchctl on macOS when able. */
async function buildDaemonSpawn(
  d: ResolvedClientDeps,
): Promise<{ command: string; args: string[] }> {
  const daemonArgs = [d.cliEntryPath, 'daemon', 'run'];
  if (d.platform === 'darwin') {
    let wrap = false;
    try {
      const { code } = await d.exec(
        '/bin/launchctl',
        ['asuser', String(d.uid), '/usr/bin/true'],
        d.launchctlTimeoutMs,
      );
      wrap = code === 0;
    } catch {
      wrap = false;
    }
    if (wrap) {
      return { command: '/bin/launchctl', args: ['asuser', String(d.uid), d.execPath, ...daemonArgs] };
    }
  }
  return { command: d.execPath, args: daemonArgs };
}

/**
 * Resolve the live daemon, auto-starting it on miss and waiting (bounded) for it
 * to come up. Throws a SyntaurError with remediation if it never becomes
 * reachable.
 */
export async function ensureDaemon(deps: ClientDeps = {}): Promise<CurrentPointer> {
  const d = resolveDeps(deps);
  const discovery = { probe: d.probe, readFile: d.readFile, now: d.now, sleep: d.sleep };

  const existing = await resolveDaemon(currentPointerPath(), discovery);
  if (existing) return existing;

  const { command, args } = await buildDaemonSpawn(d);
  const child = d.spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref?.();

  return waitForDaemon(currentPointerPath(), discovery, {
    timeoutMs: d.waitTimeoutMs,
    intervalMs: d.waitIntervalMs,
  });
}

/**
 * One-shot control request: connect, send one frame, resolve the first reply.
 * (subscribe streams — use a dedicated path for it, not this.)
 */
export function sendRequest(
  controlSock: string,
  req: ControlRequest,
  timeoutMs = 5000,
): Promise<ControlReply> {
  return new Promise<ControlReply>((resolvePromise, reject) => {
    let settled = false;
    const socket: Socket = connect(controlSock);
    const decoder = createLineDecoder<ControlReply>();
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      fn();
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new SyntaurError('Timed out awaiting a daemon reply.', {
              remediation: 'Check `syntaur daemon status` and ~/.syntaur/daemon.log.',
            }),
          ),
        ),
      timeoutMs,
    );
    socket.on('connect', () => socket.write(encodeFrame(req)));
    socket.on('data', (chunk: Buffer) => {
      const frames = decoder.push(chunk);
      if (frames.length > 0) finish(() => resolvePromise(frames[0]));
    });
    socket.on('error', (err) => finish(() => reject(err)));
  });
}

/** ensureDaemon() then a one-shot request against its control socket. */
export async function daemonRequest(req: ControlRequest, deps: ClientDeps = {}): Promise<ControlReply> {
  const pointer = await ensureDaemon(deps);
  const send = deps.sendRequest ?? sendRequest;
  return send(pointer.controlSock, req);
}
