// Daemon discovery + single-instance election (Decision 5).
//
//   daemon.lock   exclusive-create ({wx}) holding {pid, procStart, daemonId}.
//                 Stale when its pid is dead OR its procStart no longer matches
//                 the live process — then it's unlinked and re-acquired.
//   current.json  {daemonId, controlSock, pid, procStart}, written by the winner
//                 ONLY after control.sock binds. Clients resolve through it with
//                 a connect-probe; a contention loser polls it until the winner's
//                 control.sock accepts (bounded wait, then an actionable error).

import { openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { SyntaurError } from '../errors.js';
import { isPidAlive, isSameProcess, pidStartedAt, type LivenessDeps } from './liveness.js';
import { probeUnixSocket, type ProbeResult } from './sockets.js';
import type { CurrentPointer, DaemonLock } from './types.js';

export interface DiscoveryDeps extends LivenessDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  probe?: (path: string) => Promise<ProbeResult>;
  readFile?: (path: string) => string | null;
  /** Exclusive create (O_EXCL). Returns false on EEXIST, true on success. */
  createExclusive?: (path: string, data: string) => boolean;
  writeFile?: (path: string, data: string) => void;
  unlink?: (path: string) => void;
}

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function defaultCreateExclusive(path: string, data: string): boolean {
  try {
    const fd = openSync(path, 'wx');
    try {
      writeFileSync(fd, data);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

function resolveDeps(deps: DiscoveryDeps): Required<DiscoveryDeps> {
  return {
    isPidAlive: deps.isPidAlive ?? isPidAlive,
    pidStartedAt: deps.pidStartedAt ?? pidStartedAt,
    now: deps.now ?? (() => Date.now()),
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    probe: deps.probe ?? ((p) => probeUnixSocket(p)),
    readFile: deps.readFile ?? defaultReadFile,
    createExclusive: deps.createExclusive ?? defaultCreateExclusive,
    writeFile: deps.writeFile ?? ((p, data) => writeFileSync(p, data)),
    unlink: deps.unlink ?? ((p) => unlinkSync(p)),
  };
}

function parseLock(raw: string | null): DaemonLock | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as DaemonLock;
    if (typeof v?.pid === 'number' && typeof v?.daemonId === 'string') return v;
    return null;
  } catch {
    return null;
  }
}

function parsePointer(raw: string | null): CurrentPointer | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as CurrentPointer;
    if (typeof v?.controlSock === 'string' && typeof v?.daemonId === 'string') return v;
    return null;
  } catch {
    return null;
  }
}

/**
 * Attempt to acquire the daemon lock. Returns true on acquisition. A stale lock
 * (dead pid, or recycled pid whose start-time no longer matches) is unlinked and
 * retried once; a live lock yields false (caller should wait / yield).
 */
export function acquireDaemonLock(
  lock: DaemonLock,
  lockPath: string,
  deps: DiscoveryDeps = {},
): boolean {
  const d = resolveDeps(deps);
  const payload = JSON.stringify(lock);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (d.createExclusive(lockPath, payload)) return true;
    const existing = parseLock(d.readFile(lockPath));
    if (existing === null) {
      // Vanished or corrupt — treat as stale and retry the exclusive create.
      d.unlink(lockPath);
      continue;
    }
    if (isSameProcess(existing.pid, existing.procStart, d)) return false; // live owner
    d.unlink(lockPath); // stale — remove and retry
  }
  return false;
}

/** Release a lock only if we still own it (daemonId match). Best-effort. */
export function releaseDaemonLock(daemonId: string, lockPath: string, deps: DiscoveryDeps = {}): void {
  const d = resolveDeps(deps);
  const existing = parseLock(d.readFile(lockPath));
  if (existing && existing.daemonId === daemonId) {
    try {
      d.unlink(lockPath);
    } catch {
      /* already gone */
    }
  }
}

/** Write the active-daemon pointer (call only after control.sock binds). */
export function writeCurrentPointer(
  pointer: CurrentPointer,
  pointerPath: string,
  deps: DiscoveryDeps = {},
): void {
  const d = resolveDeps(deps);
  d.writeFile(pointerPath, JSON.stringify(pointer));
}

/**
 * Resolve the live daemon from current.json: read + parse, then connect-probe
 * its control socket. Returns the pointer only when the socket accepts;
 * otherwise null (missing/corrupt pointer, or dead control socket).
 */
export async function resolveDaemon(
  pointerPath: string,
  deps: DiscoveryDeps = {},
): Promise<CurrentPointer | null> {
  const d = resolveDeps(deps);
  const pointer = parsePointer(d.readFile(pointerPath));
  if (pointer === null) return null;
  const r = await d.probe(pointer.controlSock);
  return r === 'live' ? pointer : null;
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * Poll current.json until its control socket accepts, or the bounded wait
 * elapses (the contention-loser path). Throws an actionable SyntaurError on
 * timeout.
 */
export async function waitForDaemon(
  pointerPath: string,
  deps: DiscoveryDeps = {},
  options: WaitOptions = {},
): Promise<CurrentPointer> {
  const d = resolveDeps(deps);
  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = d.now() + timeoutMs;
  for (;;) {
    const pointer = await resolveDaemon(pointerPath, deps);
    if (pointer) return pointer;
    if (d.now() >= deadline) {
      throw new SyntaurError('Timed out waiting for the Syntaur daemon to become reachable.', {
        remediation: 'Start it with `syntaur daemon run`, or inspect ~/.syntaur/daemon.log.',
      });
    }
    await d.sleep(intervalMs);
  }
}
