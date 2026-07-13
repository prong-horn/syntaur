// PID liveness + recycle-guard helpers, shared by discovery (Task 2) and the
// roster (Task 3). Copies the proven approach from
// `src/dashboard/session-liveness.ts`: `process.kill(pid, 0)` with EPERM=alive,
// and a `ps -o lstart=` start-time comparison so a recycled PID (same number,
// different process) reports as dead.

import { captureProcessStartedAt } from '../utils/process-info.js';

/** True when a process with `pid` currently exists (EPERM counts as alive). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // Signal 0 probes existence + permission without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Current `ps -o lstart=` start-time string for `pid`, or null. */
export const pidStartedAt = captureProcessStartedAt;

/** Injectable seam so callers/tests can avoid touching real processes. */
export interface LivenessDeps {
  isPidAlive?: (pid: number) => boolean;
  pidStartedAt?: (pid: number) => string | null;
}

/**
 * Tri-state process identity:
 *   'alive'   — the pid exists and (if a start-time baseline was recorded) it
 *               still matches, so this is the SAME process.
 *   'dead'    — the pid is gone, OR its start-time no longer matches the
 *               baseline (a recycled pid — a different process).
 *   'unknown' — the pid exists but its current start-time could not be read
 *               (`ps` returned null for a live pid), so identity is unconfirmable.
 *
 * The tri-state matters because a boolean forces one threshold for two opposite
 * decisions. DESTRUCTIVE actions (reclaim a lock, reap a session's sockets)
 * must require confirmed 'dead' — never act on 'unknown', or a transient `ps`
 * hiccup would steal a live daemon's lock or reap a live session. TRUST actions
 * (adopt-and-signal, kill) require confirmed 'alive' — never trust 'unknown', or
 * a recycled pid could be signaled. 'unknown' is the retain/yield middle ground.
 */
export type ProcessIdentity = 'alive' | 'dead' | 'unknown';

export function processIdentity(
  pid: number,
  expectedStart: string | null,
  deps: LivenessDeps = {},
): ProcessIdentity {
  const alive = (deps.isPidAlive ?? isPidAlive)(pid);
  if (!alive) return 'dead';
  if (!expectedStart) return 'alive'; // no baseline → trust kill -0
  const current = (deps.pidStartedAt ?? pidStartedAt)(pid);
  if (current === null) return 'unknown'; // live but unconfirmable
  return current === expectedStart ? 'alive' : 'dead';
}

/**
 * True only when `pid` is the confirmed SAME process (identity 'alive'). Used by
 * TRUST gates (attach/kill): 'unknown' returns false so a possibly-recycled pid
 * is never signaled. Reap/reclaim gates must NOT use this — they check
 * `processIdentity(...) === 'dead'` so they never destroy on 'unknown'.
 */
export function isSameProcess(
  pid: number,
  expectedStart: string | null,
  deps: LivenessDeps = {},
): boolean {
  return processIdentity(pid, expectedStart, deps) === 'alive';
}
