// Daemon discovery + single-instance election (Decision 5).
//
//   daemon.lock   exclusive-create ({wx}) holding {pid, procStart, daemonId}.
//                 Stale when its pid is dead OR its procStart no longer matches
//                 the live process — then it's unlinked and re-acquired.
//   current.json  {daemonId, controlSock, pid, procStart}, written by the winner
//                 ONLY after control.sock binds. Clients resolve through it with
//                 a connect-probe; a contention loser polls it until the winner's
//                 control.sock accepts (bounded wait, then an actionable error).

import { linkSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { SyntaurError } from '../errors.js';
import { isPidAlive, pidStartedAt, processIdentity, type LivenessDeps } from './liveness.js';
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
  // Write the FULL payload to a pid-unique temp, then hard-link it into place.
  // link() is atomic and fails EEXIST if the lock already exists, so the lock
  // at `path` is only ever visible fully-formed — never the empty window that
  // `openSync('wx')` + a separate write would expose (which a concurrent
  // contender could parse as corrupt and wrongly unlink).
  // A unique per-attempt temp name created EXCLUSIVELY (`wx`): a random suffix
  // means we never collide with — or rewrite through a hard link — a temp left
  // behind by a crash mid-create (which, with a pid-only name after pid reuse,
  // could otherwise rewrite the live lock's content via the surviving hard link).
  const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
    try {
      linkSync(tmp, path);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* temp already gone */
    }
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
    const raw = d.readFile(lockPath);
    if (raw === null) {
      // Lock ABSENT at read time — a contender just reclaimed a stale lock and
      // is between its unlink and its create. Do NOT unlink (there is nothing
      // to remove, and racing our own unlink could clobber the contender's
      // fresh lock); simply retry the create.
      continue;
    }
    const existing = parseLock(raw);
    if (existing === null) {
      // Present but unparseable. Atomic-link creation never exposes a corrupt
      // or empty lock, so no live daemon holds this — it is genuine garbage
      // (external tampering, or a crashed pre-link writer). Safe to reclaim.
      d.unlink(lockPath);
      continue;
    }
    // Reclaim ONLY a confirmed-dead owner. A live owner — or one whose identity
    // is unknown (a transient `ps` failure on a live pid) — must be yielded to,
    // never stolen.
    if (processIdentity(existing.pid, existing.procStart, d) !== 'dead') return false;
    // Confirmed-dead owner: reclaim by unlinking, then retry the create.
    // (Residual: two contenders both reclaiming the same stale lock can race
    // here; a full fix is an advisory OS lock — tracked as a follow-up.)
    d.unlink(lockPath);
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
