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
 * True when `pid` is alive AND — if a start-time baseline was recorded — the
 * current start-time still matches it. A null/empty baseline trusts `kill -0`
 * alone (matching `captureProcessStartedAt`'s documented sentinel behavior).
 */
export function isSameProcess(
  pid: number,
  expectedStart: string | null,
  deps: LivenessDeps = {},
): boolean {
  const alive = (deps.isPidAlive ?? isPidAlive)(pid);
  if (!alive) return false;
  if (!expectedStart) return true;
  const current = (deps.pidStartedAt ?? pidStartedAt)(pid);
  if (current !== null && current !== expectedStart) return false;
  return true;
}
