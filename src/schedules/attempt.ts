/**
 * Job-attempt state machine + claim-lease + dedupe + reaping (Task 7).
 *
 * Crash-safety contract (Codex P0): `claimJob` advances the cursor + records the
 * consumed dedupe key and writes the `claimed` state to disk (atomic temp+rename
 * via the store) BEFORE returning — i.e. before anything is dispatched. A crash
 * between claim and dispatch therefore cannot refire the edge; it only leaves a
 * reapable `claimed`/`dispatching` job. Concurrency is handled by a per-job
 * advisory lock mirroring `src/lifecycle/recompute.ts` `acquireLock` (O_EXCL
 * `wx` lockfile, `pid:hash` token, 30s stale takeover), plus the `claim` lease.
 *
 * Timing invariant: `claimTtlMs > ackTimeoutMs + launchSlackMs` (asserted in
 * `claimJob`), and the claim is RENEWED on entering `dispatching`, so a job is
 * never reaped while still legitimately inside its dispatch window.
 *
 * Phase 4 (Decision 3): an attempt is a CHAT MESSAGE. It carries a `messageId`
 * and nothing else — no session id, no pid. Liveness is `probeMessageTurn`,
 * and killing withdraws the queued message or cancels the running turn through
 * the broker.
 */

import { createHash } from 'node:crypto';
import { open, readFile, stat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { appendEvent } from './event-log.js';
import { schedulesDir, readJob, writeJob } from './store.js';
import { isRecurring } from './triggers.js';
import { nowTimestamp } from '../utils/timestamp.js';
import type { MessageTurnLiveness } from './liveness.js';
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
   * Where the dispatched message's turn stands — `open`, `ended`, or `unknown`.
   * Production wires this to `messageTurnProbeVia` over the in-process broker or
   * the chat REST route; tests inject a stub. Defaults to `unknown`, so reaping
   * never fires on an absent signal until the ceiling below.
   */
  probeMessageTurn?: (assignmentId: string, messageId: string) => Promise<MessageTurnLiveness>;
  /**
   * How long a `running` job may sit with an UNKNOWN message state before it is
   * terminalized anyway. Without a ceiling a bad `messageId`, a reindexed chat
   * or a permanently-down dashboard leaves the job `running` forever, because
   * `unknown` reads as open. Default 2 h.
   */
  stateUnknownCeilingMs?: number;
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

/**
 * claimed → dispatching. Records the accepted `messageId` and renews the claim
 * lease so the dispatch window can't be reaped.
 */
export async function markDispatching(
  job: ScheduledJob,
  messageId: string,
  deps: AttemptDeps,
): Promise<ScheduledJob> {
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
        state: 'dispatching',
        messageId,
        dispatchedAt: isoStamp(now),
        claim: f.attempt.claim
          ? { ...f.attempt.claim, expiresAt: now.getTime() + f.timing.claimTtlMs }
          : null,
      },
    };
  });
  if (written) await appendEvent(job.id, 'dispatching', { messageId });
  return written ?? fresh ?? job;
}

/**
 * dispatching → running. The chat accepted the message, which IS the ack
 * (Decision 3) — the attempt now runs for as long as the message's turn does.
 */
export async function markRunning(job: ScheduledJob, deps: AttemptDeps): Promise<ScheduledJob> {
  const now = deps.now();
  const token = job.attempt.claim?.token;
  let messageId: string | null = null;
  const { written, fresh } = await lockedTransition(job.id, (f) => {
    if (f.attempt.state !== 'dispatching' || f.attempt.claim?.token !== token) return null;
    messageId = f.attempt.messageId;
    return {
      ...f,
      attempt: {
        ...f.attempt,
        state: 'running',
        runningSince: isoStamp(now),
        dispatchCount: f.attempt.dispatchCount + 1,
        launchDayStamps: pruneDayStamps(f.attempt.launchDayStamps, now),
        claim: null, // message accepted — lease no longer needed
      },
    };
  });
  if (written) {
    await appendEvent(job.id, 'ack', { messageId });
    await appendEvent(job.id, 'running', { messageId });
  }
  return written ?? fresh ?? job;
}

/**
 * Recurring (cron) success path: record the accepted dispatch AND re-arm to
 * `eligible` for the next occurrence in ONE atomic write. This is crash-safe —
 * the prior `markRunning`-then-`reArm` two-step could strand a cron job in
 * `running` forever if the process died between the writes (Codex review). The
 * dispatched turn keeps running independently, tracked via `messageId` + the
 * event log; cron runs are fire-and-forget for reaping. `consumedEdges`/`cursor`
 * are kept so the SAME occurrence never refires — a new occurrence is a new key.
 */
export async function markRanAndReArm(job: ScheduledJob, deps: AttemptDeps): Promise<ScheduledJob> {
  const now = deps.now();
  const token = job.attempt.claim?.token;
  let messageId: string | null = null;
  const { written, fresh } = await lockedTransition(job.id, (f) => {
    if (f.attempt.state !== 'dispatching' || f.attempt.claim?.token !== token) return null;
    messageId = f.attempt.messageId;
    return {
      ...f,
      attempt: {
        ...f.attempt,
        state: 'eligible',
        dispatchCount: f.attempt.dispatchCount + 1,
        launchDayStamps: pruneDayStamps(f.attempt.launchDayStamps, now),
        claim: null,
        dispatchedAt: null,
        runningSince: null,
      },
    };
  });
  if (written) {
    await appendEvent(job.id, 'ack', { messageId });
    await appendEvent(job.id, 'running', { messageId });
    await appendEvent(job.id, 'rescheduled', { reason: 'recurring' });
  }
  return written ?? fresh ?? job;
}

/** claimed | dispatching → dispatch_failed (the chat refused it, or reaped). */
export async function markDispatchFailed(job: ScheduledJob, reason: string): Promise<ScheduledJob> {
  const token = job.attempt.claim?.token;
  const { written, fresh } = await lockedTransition(job.id, (f) => {
    if (f.attempt.state !== 'claimed' && f.attempt.state !== 'dispatching') return null;
    if (f.attempt.claim?.token !== token) return null; // different attempt
    return { ...f, attempt: { ...f.attempt, state: 'dispatch_failed', claim: null, lastError: reason } };
  });
  if (written) await appendEvent(job.id, 'dispatch_failed', { reason });
  return written ?? fresh ?? job;
}

/**
 * running → completed (terminal). The one-shot completion path: a fired
 * one-shot has no re-arm, so once its dispatched message's turn has ended the
 * schedule's single job (get the agent working) is done. Reaped by `reapStale`
 * behind a grace window so a just-accepted message whose turn has not started
 * yet is never prematurely terminalized. `completed` is a valid terminal state +
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

export interface KillDeps {
  /** Withdraw the still-queued message; false once a target has started it. */
  withdrawMessage?: (assignmentId: string, messageId: string) => Promise<boolean>;
  /** Cancel the agent's running turn (`session/cancel` through the broker). */
  cancelTurn?: (assignmentId: string, agentId: string | null) => Promise<boolean>;
}

/**
 * running → killed, claimed | dispatching → cancelled.
 *
 * There is no pid to signal (Decision 3). A job whose message is still QUEUED is
 * withdrawn — it never reaches an agent at all; one whose turn is already
 * running is cancelled through the broker, which is `session/cancel` and
 * resolves in tens of milliseconds on both adapters. A withdraw that comes too
 * late (a target started between the read and the call) falls through to a
 * cancel, so "kill" always stops what is actually running.
 */
export async function killJob(id: string, deps?: KillDeps): Promise<ScheduledJob> {
  const release = await acquireJobLock(id);
  try {
    const job = await readJob(id);
    if (!job) throw new TransitionError(`No such schedule: ${id}`);
    const s = job.attempt.state;
    const { messageId } = job.attempt;
    if (s === 'running' || s === 'dispatching') {
      let withdrawn = false;
      if (messageId && deps?.withdrawMessage) {
        withdrawn = await deps.withdrawMessage(job.assignmentId, messageId).catch(() => false);
      }
      if (!withdrawn && deps?.cancelTurn) {
        await deps.cancelTurn(job.assignmentId, job.agentId).catch(() => false);
      }
      const to = s === 'running' ? 'killed' : 'cancelled';
      const written = await writeJob({ ...job, attempt: { ...job.attempt, state: to, claim: null } });
      await appendEvent(id, to === 'killed' ? 'killed' : 'cancelled', {
        messageId,
        via: withdrawn ? 'withdraw' : 'cancel',
      });
      return written;
    }
    if (s === 'claimed') {
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

/** failed | dispatch_failed → eligible (fresh attempt; new dedupe scope keeps
 *  the consumed edges so the SAME edge won't refire — a clock re-fires on its
 *  next occurrence, a state edge on a new transition). */
export function retryJob(id: string): Promise<ScheduledJob> {
  return controlTransition(
    id,
    (s) => s === 'failed' || s === 'dispatch_failed',
    'eligible',
    'retried',
    () => ({ claim: null, lastError: null }),
  );
}

// ── Reaping (crash recovery + stuck detection — mechanism, not policy) ─────────

export interface ReapOutcome {
  reaped: string[]; // ids moved to dispatch_failed (dead dispatches)
  stuck: string[]; // ids flagged stuck (left for a control verb to remediate)
  completed: string[]; // one-shot ids reconciled to completed (session ended)
}

/**
 * Grace window before a one-shot `running` job whose turn has ended is
 * reconciled to `completed`. A job's `maxRuntimeMs` takes precedence; this is
 * the floor used when no limit is set, guarding against terminalizing a message
 * whose turn has not started yet right after the dispatch was accepted.
 */
const ONE_SHOT_COMPLETE_GRACE_MS = 60_000;

/**
 * Default ceiling on how long a `running` job may report an UNKNOWN message
 * state before `reapStale` terminalizes it (code review finding 5). Generous on
 * purpose: a dashboard restart or a brief network blip must not cost a live job,
 * and two hours is far longer than either.
 */
const STATE_UNKNOWN_CEILING_MS = 2 * 60 * 60 * 1000;

/**
 * Crash recovery + stuck detection. PURE MECHANISM: it completes the lifecycle
 * of demonstrably-dead dispatches (claim lease expired while
 * claimed/dispatching → `dispatch_failed`) and RECORDS — but does not remediate
 * — running jobs past their max-runtime whose turn has ended (stuck is derivable
 * from disk; a human/orchestrator calls `kill`/`retry`).
 */
export async function reapStale(jobs: ScheduledJob[], deps: AttemptDeps): Promise<ReapOutcome> {
  const now = deps.now();
  const probe = deps.probeMessageTurn ?? (async () => 'unknown' as MessageTurnLiveness);
  const unknownCeilingMs = deps.stateUnknownCeilingMs ?? STATE_UNKNOWN_CEILING_MS;
  const out: ReapOutcome = { reaped: [], stuck: [], completed: [] };
  for (const job of jobs) {
    const a = job.attempt;
    if ((a.state === 'claimed' || a.state === 'dispatching') && a.claim && now.getTime() > a.claim.expiresAt) {
      // Re-validate state AND expiry on fresh under the lock — `markDispatching`
      // may have renewed the claim since this snapshot was read.
      const reason = `reaped: claim lease expired in state '${a.state}'`;
      const { written } = await lockedTransition(job.id, (f) => {
        if (f.attempt.state !== 'claimed' && f.attempt.state !== 'dispatching') return null;
        if (!f.attempt.claim || now.getTime() <= f.attempt.claim.expiresAt) return null;
        return { ...f, attempt: { ...f.attempt, state: 'dispatch_failed', claim: null, lastError: reason } };
      });
      if (written) {
        await appendEvent(job.id, 'dispatch_failed', { reason });
        await appendEvent(job.id, 'reaped', { from: a.state });
        out.reaped.push(job.id);
      }
      continue;
    }
    if (a.state !== 'running') continue;

    // ── One-shot completion reconciliation (B7) ──────────────────────────────
    // A fired one-shot never re-arms; once its dispatched message's turn has
    // ended, the schedule's single job (get the agent working) is done →
    // completed. Anti-race: only when it has a `messageId` whose turn has
    // finished AND `runningSince` is older than the grace window (reuse
    // maxRuntimeMs if set, else a const default). Never terminalize a one-shot
    // with no `messageId` (leave that to the claim-lease reaping), and NEVER do
    // this for recurring jobs.
    const liveness = a.messageId ? await probe(job.assignmentId, a.messageId) : 'unknown';

    // ── The state-unknown ceiling (code review finding 5) ────────────────────
    // `unknown` reads as open, which is correct until it is not: a job nobody
    // can resolve must not sit in `running` for ever.
    //
    // The clock starts at the FIRST unknown probe, not at `runningSince` (review
    // round 2, finding 1). Measured from `runningSince` the grace period would
    // shrink with every healthy minute — a job that ran fine for 110 minutes and
    // then lost the dashboard would get ten, not the two hours the release note
    // promises. `stateUnknownSince` is persisted so a restart mid-outage does
    // not reset it, and cleared on any definite answer so unrelated blips never
    // accumulate.
    if (liveness === 'unknown') {
      const since = a.stateUnknownSince;
      if (!since) {
        // First unknown probe: start the clock and let this pass go by.
        await lockedTransition(job.id, (f) =>
          f.attempt.state === 'running' &&
          f.attempt.messageId === a.messageId &&
          !f.attempt.stateUnknownSince
            ? { ...f, attempt: { ...f.attempt, stateUnknownSince: isoStamp(now) } }
            : null,
        );
        continue;
      }
      const unknownFor = now.getTime() - Date.parse(since);
      if (unknownFor > unknownCeilingMs) {
        const reason = `state_unknown: the chat could not resolve message ${a.messageId ?? '(none)'} for ${Math.round(unknownFor / 60000)}m`;
        const { written } = await lockedTransition(job.id, (f) => {
          if (
            f.attempt.state !== 'running' ||
            f.attempt.messageId !== a.messageId ||
            f.attempt.stateUnknownSince !== since
          ) {
            return null;
          }
          return { ...f, attempt: { ...f.attempt, state: 'dispatch_failed', claim: null, lastError: reason } };
        });
        if (written) {
          await appendEvent(job.id, 'dispatch_failed', { reason });
          await appendEvent(job.id, 'reaped', { reason: 'state_unknown', messageId: a.messageId });
          out.reaped.push(job.id);
        }
        continue;
      }
      // Inside the ceiling — still treated as open, nothing else to decide.
      continue;
    }

    // A definite answer clears the marker, so the next outage starts a fresh
    // ceiling rather than resuming a stale one.
    if (a.stateUnknownSince) {
      await lockedTransition(job.id, (f) =>
        f.attempt.stateUnknownSince ? { ...f, attempt: { ...f.attempt, stateUnknownSince: null } } : null,
      );
    }

    if (!isRecurring(job.trigger) && a.messageId && a.runningSince) {
      const graceMs = job.limits.maxRuntimeMs ?? ONE_SHOT_COMPLETE_GRACE_MS;
      const pastGrace = now.getTime() - Date.parse(a.runningSince) > graceMs;
      if (pastGrace && liveness === 'ended') {
        const { written } = await lockedTransition(job.id, (f) => {
          // Same running attempt the grace/liveness check was based on — else a
          // newer run could be completed off a stale snapshot.
          if (
            f.attempt.state !== 'running' ||
            f.attempt.messageId !== a.messageId ||
            f.attempt.runningSince !== a.runningSince
          ) {
            return null;
          }
          return { ...f, attempt: { ...f.attempt, state: 'completed', claim: null } };
        });
        if (written) {
          await appendEvent(job.id, 'completed', { reason: 'one-shot turn ended' });
          out.completed.push(job.id);
        }
        continue;
      }
    }

    // ── Stuck detection (B8) — mechanism, not policy ─────────────────────────
    // Record once; leave state running (stuck is derivable). No remediation.
    if (job.limits.maxRuntimeMs && a.runningSince) {
      const overrun = now.getTime() - Date.parse(a.runningSince) > job.limits.maxRuntimeMs;
      if (overrun && liveness === 'ended' && a.lastError !== 'stuck:max-runtime') {
        const { written } = await lockedTransition(job.id, (f) => {
          if (
            f.attempt.state !== 'running' ||
            f.attempt.messageId !== a.messageId ||
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
