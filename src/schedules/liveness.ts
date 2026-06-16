/**
 * Shared liveness signal for the scheduler tick (B8 + B7).
 *
 * `reapStale` (stuck detection) and the one-shot completion reconciliation both
 * need to know whether a launched scheduled session is still alive. A bare
 * `process.kill(launchPid, 0)` is WRONG: for osascript/open/sh launches the
 * `launchPid` is only the *wrapper* process (see the comment at
 * `src/commands/schedule.ts` `killJob`), which may already be dead while the
 * real agent is alive — so it would false-negative and prematurely
 * complete/stuck a LIVE job.
 *
 * Resolution order (this exact order prevents false-negatives):
 *   1. `sessionId` set AND has a registry row → use the registry's SYNC
 *      liveness (`computeIsLive`), which already applies a pid + start-time
 *      guard against PID reuse.
 *   2. `sessionId` set but NO registry row yet → return TRUE (live/unknown):
 *      the row may not be written right after launch-ack. Never fall back to
 *      `launchPid` here, never terminalize on this basis.
 *   3. `sessionId` null/empty (no session at all) → fall back to a sync
 *      `process.kill(launchPid, 0)` check (true if it doesn't throw; false on
 *      ESRCH). `launchPid` null → TRUE (unknown).
 */

import { computeIsLive } from '../dashboard/session-liveness.js';
import { getSessionById } from '../dashboard/agent-sessions.js';
import { initSessionDb } from '../dashboard/session-db.js';

/** True when a process with the given pid is currently running. */
function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // Signal 0 doesn't deliver — it only probes existence + permission.
    // ESRCH: no such process; EPERM: process exists but we cannot signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

/**
 * Synchronous liveness of a launched scheduled session. Wired as the production
 * `isSessionLive` dep for the tick / `reapStale`.
 */
export function isScheduledSessionLive(
  sessionId: string | null,
  launchPid: number | null,
): boolean {
  if (sessionId) {
    let row = null;
    try {
      initSessionDb();
      row = getSessionById(sessionId);
    } catch {
      // DB unavailable — treat as unknown rather than terminalizing a LIVE job.
      return true;
    }
    // (2) Known session id but no registry row yet → live/unknown.
    if (!row) return true;
    // (1) Registry row → authoritative sync liveness (pid + start-time guard).
    return computeIsLive(row);
  }
  // (3) No session at all → fall back to the wrapper pid.
  if (launchPid == null) return true;
  return isPidAlive(launchPid);
}
