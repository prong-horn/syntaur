/**
 * Job-attempt state machine + claim-lease + dedupe + reaping (Task 7).
 *
 * Crash-safety contract (Codex P0): `claimJob` advances the cursor + records the
 * consumed dedupe key and writes the `claimed` state to disk (atomic temp+rename
 * via the store) BEFORE returning — i.e. before any launch. A crash between
 * claim and launch therefore cannot refire the edge; it only leaves a reapable
 * `claimed`/`launching` job. Concurrency is handled by a per-job advisory lock
 * mirroring `src/lifecycle/recompute.ts` `acquireLock` (O_EXCL `wx` lockfile,
 * `pid:hash` token, 30s stale takeover), plus the `claim` lease on the job.
 *
 * Timing invariant: `claimTtlMs > ackTimeoutMs + launchSlackMs` (asserted in
 * `claimJob`), and the claim is RENEWED on entering `launching`, so a job is
 * never reaped while still legitimately inside its launch-ack window.
 */

import { createHash } from 'node:crypto';
import { open, readFile, stat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { appendEvent } from './event-log.js';
import { schedulesDir, readJob, writeJob } from './store.js';
import { isRecurring } from './triggers.js';
import { nowTimestamp } from '../utils/timestamp.js';
import {
  type ScheduledJob,
  type JobAttemptState,
  type JobTrigger,
  assertTimingInvariant,
  freshAttempt,
  isTerminalJobState,
} from './types.js';

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 50;
const LOCK_MAX_WAITS = 100; // ~5s

// Cap on retained dedupe keys. A tick only ever checks the CURRENT occurrence's
// key (cron emits the single most-recent past occurrence; state edges advance a
// cursor), so retaining the most recent N is safe and keeps a long-lived cron
// job's file from growing without bound. (AC3)
const MAX_CONSUMED_EDGES = 50;

export interface AttemptDeps {
  now: () => Date;
  /**
   * Liveness of the running job's launched session. Production wires this to the
   * dashboard `computeIsLive`/`enrichSessions` heartbeat; tests inject a stub.
   * Defaults to "assume live" so reaping never fires without an explicit signal.
   */
  isSessionLive?: (sessionId: string | null, pid: number | null) => boolean;
}

export interface FiredEdge {
  dedupeKey: string;
  /** State-trigger cursor to persist on claim (omitted for clock triggers). */
  nextCursor?: number;
}

export type ClaimResult =
  | { claimed: true; job: ScheduledJob }
  | { claimed: false; reason: string };

/** Acquire the per-job advisory lock; returns a release fn. Mirrors recompute.ts. */
async function acquireJobLock(id: string): Promise<() => Promise<void>> {
  const lockPath = resolve(schedulesDir(), `${id}.lock`);
  const token = `${process.pid}:${createHash('sha256')
    .update(`${Math.random()}${Date.now()}`)
    .digest('hex')
    .slice(0, 12)}`;
  for (let attempt = 0; attempt <= LOCK_MAX_WAITS; attempt++) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(token, 'utf-8');
      await handle.close();
      return async () => {
        try {
          const current = await readFile(lockPath, 'utf-8');
          if (current === token) await unlink(lockPath);
        } catch {
          /* already gone — fine */
        }
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {
        continue;
      }
      await new Promise((r) => setTimeout(r, LOCK_WAIT_MS));
    }
  }
  throw new Error(`Timed out waiting for schedule lock ${lockPath}`);
}

function dayStamp(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isoStamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Record today's launch and drop stamps from earlier days. `launchDayStamps`
 * only feeds `maxLaunchesPerDay` (a count of TODAY's launches), so older days
 * are dead weight that otherwise accumulates forever on a recurring job. (AC3)
 */
function pruneDayStamps(stamps: string[], now: Date): string[] {
  const today = dayStamp(now);
  return [...stamps.filter((d) => d === today), today];
}

/**
 * Locked read-modify-write for a single job (AC6). Acquires the per-job advisory
 * lock ONCE, re-reads fresh from disk, applies `mutate`, and persists only when
 * `mutate` returns a job (null = precondition no longer holds → no write). The
 * lock is never held across a nested acquisition, so this can't deadlock with
 * the other locked verbs. Returns whether a write happened so callers can gate
 * their side-effects (events / outcome arrays) on an actual transition.
 */
async function lockedTransition(
  id: string,
  mutate: (fresh: ScheduledJob) => ScheduledJob | null,
): Promise<{ written: ScheduledJob | null; fresh: ScheduledJob | null }> {
  const release = await acquireJobLock(id);
  try {
    const fresh = await readJob(id);
    if (!fresh) return { written: null, fresh: null };
    const next = mutate(fresh);
    if (!next) return { written: null, fresh };
    const written = await writeJob(next);
    return { written, fresh };
  } finally {
    await release();
  }
}

/**
 * Claim a due edge. Persists cursor/dedupe/claim BEFORE returning. Idempotent
 * under races: the lock serializes the read-modify-write, and a re-check inside
 * rejects an edge another actor already consumed or a non-eligible job.
 */
export async function claimJob(job: ScheduledJob, edge: FiredEdge, deps: AttemptDeps): Promise<ClaimResult> {
  assertTimingInvariant(job.timing);
  const release = await acquireJobLock(job.id);
  try {
    // Re-read under the lock — never act on a stale in-memory snapshot.
    const fresh = (await readJob(job.id)) ?? job;
    if (fresh.attempt.state !== 'eligible') {
      return { claimed: false, reason: `not-eligible:${fresh.attempt.state}` };
    }
    if (fresh.attempt.consumedEdges.includes(edge.dedupeKey)) {
      return { claimed: false, reason: 'already-consumed' };
    }
    const now = deps.now();
    const token = `${process.pid}:${createHash('sha256')
      .update(`${Math.random()}${now.getTime()}`)
      .digest('hex')
      .slice(0, 12)}`;
    const claimed: ScheduledJob = {
      ...fresh,
      attempt: {
        ...fresh.attempt,
        state: 'claimed',
        claim: { token, expiresAt: now.getTime() + fresh.timing.claimTtlMs },
        consumedEdges: [...fresh.attempt.consumedEdges, edge.dedupeKey].slice(-MAX_CONSUMED_EDGES),
        cursor: edge.nextCursor ?? fresh.attempt.cursor,
        lastFiredAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        lastError: null,
      },
    };
    const written = await writeJob(claimed); // atomic, BEFORE any launch
    await appendEvent(job.id, 'claimed', { dedupeKey: edge.dedupeKey });
    await appendEvent(job.id, 'fired', { dedupeKey: edge.dedupeKey });
    return { claimed: true, job: written };
  } finally {
    await release();
  }
}

// All five transitions below take a `job` snapshot for its id but re-read fresh
// under the lock and re-check their precondition (AC6) — a concurrent control
// verb (kill/cancel) or a second tick can't be clobbered by a write derived
// from a stale snapshot. A precondition miss is a no-op: no write, no event.

/** claimed → launching. Renews the claim lease so the ack window can't be reaped. */
export async function markLaunching(job: ScheduledJob, pid: number | null, deps: AttemptDeps): Promise<ScheduledJob> {
  const now = deps.now();
  const token = job.attempt.claim?.token;
  const { written, fresh } = await lockedTransition(job.id, (f) => {
    // Match state AND claim identity: a job reaped→retried→reclaimed since this
    // snapshot is a DIFFERENT attempt (new token) and must not be clobbered.
    if (f.attempt.state !== 'claimed' || f.attempt.claim?.token !== token) return null;
    return {
      ...f,
      attempt: {
        ...f.attempt,
        state: 'launching',
        launchPid: pid,
        launchingSince: isoStamp(now),
        claim: f.attempt.claim
          ? { ...f.attempt.claim, expiresAt: now.getTime() + f.timing.claimTtlMs }
          : null,
      },
    };
  });
  if (written) await appendEvent(job.id, 'launching', { pid });
  return written ?? fresh ?? job;
}

/** launching → running (ack observed). Links the session + records launch counters. */
export async function markRunning(
  job: ScheduledJob,
  sessionId: string | null,
  deps: AttemptDeps,
): Promise<ScheduledJob> {
  const now = deps.now();
  const token = job.attempt.claim?.token;
  const { written, fresh } = await lockedTransition(job.id, (f) => {
    if (f.attempt.state !== 'launching' || f.attempt.claim?.token !== token) return null;
    return {
      ...f,
      attempt: {
        ...f.attempt,
        state: 'running',
        sessionId,
        runningSince: isoStamp(now),
        launchCount: f.attempt.launchCount + 1,
        launchDayStamps: pruneDayStamps(f.attempt.launchDayStamps, now),
        claim: null, // launch acknowledged — lease no longer needed
      },
    };
  });
  if (written) {
    await appendEvent(job.id, 'ack', { sessionId });
    await appendEvent(job.id, 'running', { sessionId });
  }
  return written ?? fresh ?? job;
}

/**
 * Recurring (cron) success path: record the acked launch AND re-arm to
 * `eligible` for the next occurrence in ONE atomic write. This is crash-safe —
 * the prior `markRunning`-then-`reArm` two-step could strand a cron job in
 * `running` forever if the process died between the writes (Codex review). The
 * launched session keeps running independently, tracked via `sessionId` + the
 * event log; cron runs are fire-and-forget for reaping. `consumedEdges`/`cursor`
 * are kept so the SAME occurrence never refires — a new occurrence is a new key.
 */
export async function markRanAndReArm(
  job: ScheduledJob,
  sessionId: string | null,
  deps: AttemptDeps,
): Promise<ScheduledJob> {
  const now = deps.now();
  const token = job.attempt.claim?.token;
  const { written, fresh } = await lockedTransition(job.id, (f) => {
    if (f.attempt.state !== 'launching' || f.attempt.claim?.token !== token) return null;
    return {
      ...f,
      attempt: {
        ...f.attempt,
        state: 'eligible',
        sessionId,
        launchCount: f.attempt.launchCount + 1,
        launchDayStamps: pruneDayStamps(f.attempt.launchDayStamps, now),
        claim: null,
        launchingSince: null,
        runningSince: null,
      },
    };
  });
  if (written) {
    await appendEvent(job.id, 'ack', { sessionId });
    await appendEvent(job.id, 'running', { sessionId });
    await appendEvent(job.id, 'rescheduled', { reason: 'recurring' });
  }
  return written ?? fresh ?? job;
}

/** claimed | launching → launch_failed (no ack within the window, or reaped). */
export async function markLaunchFailed(job: ScheduledJob, reason: string): Promise<ScheduledJob> {
  const token = job.attempt.claim?.token;
  const { written, fresh } = await lockedTransition(job.id, (f) => {
    if (f.attempt.state !== 'claimed' && f.attempt.state !== 'launching') return null;
    if (f.attempt.claim?.token !== token) return null; // different attempt
    return { ...f, attempt: { ...f.attempt, state: 'launch_failed', claim: null, lastError: reason } };
  });
  if (written) await appendEvent(job.id, 'launch_failed', { reason });
  return written ?? fresh ?? job;
}

/**
 * running → completed (terminal). The one-shot completion path: a fired
 * one-shot has no re-arm, so once its launched session is no longer live the
 * schedule's single job (launch the agent) is done. Reaped by `reapStale`
 * behind a grace window so a just-acked session (row/pid not registered yet) is
 * never prematurely terminalized. `completed` is a valid terminal state +
 * event (see types.ts).
 */
export async function markCompleted(job: ScheduledJob): Promise<ScheduledJob> {
  const { written, fresh } = await lockedTransition(job.id, (f) => {
    if (f.attempt.state !== 'running') return null;
    return { ...f, attempt: { ...f.attempt, state: 'completed', claim: null } };
  });
  if (written) await appendEvent(job.id, 'completed', { reason: 'one-shot session ended' });
  return written ?? fresh ?? job;
}

// ── Control verbs (Task 12 semantics, type-backed here) ───────────────────────

export class TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransitionError';
  }
}

/** Re-read under the lock, guard the current state, mutate, persist, log. */
async function controlTransition(
  id: string,
  allowed: (s: JobAttemptState) => boolean,
  to: JobAttemptState,
  event: Parameters<typeof appendEvent>[1],
  extra?: (job: ScheduledJob) => Partial<ScheduledJob['attempt']>,
): Promise<ScheduledJob> {
  const release = await acquireJobLock(id);
  try {
    const job = await readJob(id);
    if (!job) throw new TransitionError(`No such schedule: ${id}`);
    if (!allowed(job.attempt.state)) {
      throw new TransitionError(`Cannot ${event} a job in state '${job.attempt.state}'`);
    }
    const next: ScheduledJob = {
      ...job,
      attempt: { ...job.attempt, state: to, ...(extra ? extra(job) : {}) },
    };
    const written = await writeJob(next);
    await appendEvent(id, event);
    return written;
  } finally {
    await release();
  }
}

/** eligible|claimed → held (the tick skips held jobs). */
export function holdJob(id: string): Promise<ScheduledJob> {
  return controlTransition(id, (s) => s === 'eligible' || s === 'claimed', 'held', 'held', () => ({
    claim: null,
  }));
}

/** held → eligible. */
export function releaseJob(id: string): Promise<ScheduledJob> {
  return controlTransition(id, (s) => s === 'held', 'eligible', 'released');
}

/** any non-terminal → cancelled. */
export function cancelJob(id: string): Promise<ScheduledJob> {
  return controlTransition(id, (s) => !isTerminalJobState(s), 'cancelled', 'cancelled', () => ({
    claim: null,
  }));
}

/**
 * running → killed (caller signals the linked session pid first). claimed |
 * launching → cancelled (nothing durable to kill yet).
 */
export async function killJob(
  id: string,
  deps?: { signalTarget?: (target: { sessionId: string | null; launchPid: number | null }) => void },
): Promise<ScheduledJob> {
  const release = await acquireJobLock(id);
  try {
    const job = await readJob(id);
    if (!job) throw new TransitionError(`No such schedule: ${id}`);
    const s = job.attempt.state;
    if (s === 'running') {
      // Signal the TRACKED AGENT session (resolved from sessionId), not the
      // wrapper `launchPid` — for osascript/open/sh launches the wrapper pid is
      // not the agent. The caller resolves sessionId → live pid (CLI wiring).
      deps?.signalTarget?.({ sessionId: job.attempt.sessionId, launchPid: job.attempt.launchPid });
      const written = await writeJob({ ...job, attempt: { ...job.attempt, state: 'killed', claim: null } });
      await appendEvent(id, 'killed', { sessionId: job.attempt.sessionId, launchPid: job.attempt.launchPid });
      return written;
    }
    if (s === 'claimed' || s === 'launching') {
      const written = await writeJob({ ...job, attempt: { ...job.attempt, state: 'cancelled', claim: null } });
      await appendEvent(id, 'cancelled', { via: 'kill' });
      return written;
    }
    throw new TransitionError(`Cannot kill a job in state '${s}'`);
  } finally {
    await release();
  }
}

/**
 * Swap a job's trigger and FULLY re-arm it — shared by the CLI and dashboard so
 * `reschedule` is one lib verb (parity). Resets `createdAt` (the creation
 * baseline → reacts only to future edges) AND the whole attempt via
 * `freshAttempt()` — so a stale `cursor`/`consumedEdges` from the old trigger
 * can never strand the new one (a rescheduled `when-status` job whose old cursor
 * sat past the new watched history would otherwise skip every future edge).
 */
export async function rescheduleJob(id: string, trigger: JobTrigger): Promise<ScheduledJob> {
  const release = await acquireJobLock(id);
  try {
    const job = await readJob(id);
    if (!job) throw new TransitionError(`No such schedule: ${id}`);
    const next: ScheduledJob = {
      ...job,
      trigger,
      createdAt: nowTimestamp(),
      attempt: freshAttempt(),
    };
    const written = await writeJob(next);
    await appendEvent(id, 'rescheduled', { trigger: trigger.kind });
    return written;
  } finally {
    await release();
  }
}

/** failed | launch_failed → eligible (fresh attempt; new dedupe scope keeps the
 *  consumed edges so the SAME edge won't refire — a clock re-fires on its next
 *  occurrence, a state edge on a new transition). */
export function retryJob(id: string): Promise<ScheduledJob> {
  return controlTransition(
    id,
    (s) => s === 'failed' || s === 'launch_failed',
    'eligible',
    'retried',
    () => ({ claim: null, lastError: null }),
  );
}

// ── Reaping (crash recovery + stuck detection — mechanism, not policy) ─────────

export interface ReapOutcome {
  reaped: string[]; // ids moved to launch_failed (dead launches)
  stuck: string[]; // ids flagged stuck (left for a control verb to remediate)
  completed: string[]; // one-shot ids reconciled to completed (session ended)
}

/**
 * Grace window before a one-shot `running` job with a dead session is
 * reconciled to `completed`. A job's `maxRuntimeMs` takes precedence; this is
 * the floor used when no limit is set, guarding against terminalizing a session
 * whose registry row / pid hasn't been written yet right after launch-ack.
 */
const ONE_SHOT_COMPLETE_GRACE_MS = 60_000;

/**
 * Crash recovery + stuck detection. PURE MECHANISM: it completes the lifecycle
 * of demonstrably-dead launches (claim lease expired while claimed/launching →
 * `launch_failed`) and RECORDS — but does not remediate — running jobs past
 * their max-runtime with no live heartbeat (stuck is derivable from disk; a
 * human/orchestrator calls `kill`/`retry`).
 */
export async function reapStale(jobs: ScheduledJob[], deps: AttemptDeps): Promise<ReapOutcome> {
  const now = deps.now();
  const isLive = deps.isSessionLive ?? (() => true);
  const out: ReapOutcome = { reaped: [], stuck: [], completed: [] };
  for (const job of jobs) {
    const a = job.attempt;
    if ((a.state === 'claimed' || a.state === 'launching') && a.claim && now.getTime() > a.claim.expiresAt) {
      // Re-validate state AND expiry on fresh under the lock — `markLaunching`
      // may have renewed the claim since this snapshot was read.
      const reason = `reaped: claim lease expired in state '${a.state}'`;
      const { written } = await lockedTransition(job.id, (f) => {
        if (f.attempt.state !== 'claimed' && f.attempt.state !== 'launching') return null;
        if (!f.attempt.claim || now.getTime() <= f.attempt.claim.expiresAt) return null;
        return { ...f, attempt: { ...f.attempt, state: 'launch_failed', claim: null, lastError: reason } };
      });
      if (written) {
        await appendEvent(job.id, 'launch_failed', { reason });
        await appendEvent(job.id, 'reaped', { from: a.state });
        out.reaped.push(job.id);
      }
      continue;
    }
    if (a.state !== 'running') continue;

    // ── One-shot completion reconciliation (B7) ──────────────────────────────
    // A fired one-shot never re-arms; once its launched session is no longer
    // live, the schedule's single job (launch the agent) is done → completed.
    // Anti-race: only when it has a registered sessionId that is now dead/absent
    // AND runningSince is older than the grace window (reuse maxRuntimeMs if
    // set, else a const default). Never terminalize a one-shot with no
    // sessionId (leave that to launch-failure/claim-lease reaping), and NEVER
    // do this for recurring jobs.
    if (!isRecurring(job.trigger) && a.sessionId && a.runningSince) {
      const graceMs = job.limits.maxRuntimeMs ?? ONE_SHOT_COMPLETE_GRACE_MS;
      const pastGrace = now.getTime() - Date.parse(a.runningSince) > graceMs;
      if (pastGrace && !isLive(a.sessionId, a.launchPid)) {
        const { written } = await lockedTransition(job.id, (f) => {
          // Same running attempt the grace/liveness check was based on — else a
          // newer run could be completed off a stale snapshot.
          if (
            f.attempt.state !== 'running' ||
            f.attempt.sessionId !== a.sessionId ||
            f.attempt.runningSince !== a.runningSince
          ) {
            return null;
          }
          return { ...f, attempt: { ...f.attempt, state: 'completed', claim: null } };
        });
        if (written) {
          await appendEvent(job.id, 'completed', { reason: 'one-shot session ended' });
          out.completed.push(job.id);
        }
        continue;
      }
    }

    // ── Stuck detection (B8) — mechanism, not policy ─────────────────────────
    // Record once; leave state running (stuck is derivable). No remediation.
    if (job.limits.maxRuntimeMs && a.runningSince) {
      const overrun = now.getTime() - Date.parse(a.runningSince) > job.limits.maxRuntimeMs;
      if (overrun && !isLive(a.sessionId, a.launchPid) && a.lastError !== 'stuck:max-runtime') {
        const { written } = await lockedTransition(job.id, (f) => {
          if (
            f.attempt.state !== 'running' ||
            f.attempt.sessionId !== a.sessionId ||
            f.attempt.runningSince !== a.runningSince ||
            f.attempt.lastError === 'stuck:max-runtime'
          ) {
            return null;
          }
          return { ...f, attempt: { ...f.attempt, lastError: 'stuck:max-runtime' } };
        });
        if (written) {
          await appendEvent(job.id, 'reaped', { stuck: 'max-runtime-no-heartbeat' });
          out.stuck.push(job.id);
        }
      }
    }
  }
  return out;
}
