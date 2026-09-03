/**
 * Type model for the scheduled-agents feature (see the assignment's plan.md).
 *
 * A `ScheduledJob` persists **intent** (which assignment, which chat agent,
 * which message, which trigger, what unattended limits) — never a resolved
 * execution spec. On tick the message is posted into the assignment's chat
 * (Decision 3, phase 4): in-process through the broker inside the dashboard
 * server, otherwise over the chat REST route on the running dashboard. There is
 * no terminal, no pid and no launch plan.
 *
 * The store is per-file + markdown frontmatter (auditable like an assignment),
 * NOT SQLite — a deliberate divergence from the leases/sessions precedent
 * because a schedule is an intent-as-document a human edits and reviews. All
 * mutable attempt state lives in the job file's frontmatter (one authoritative
 * record per job); the JSONL event log alongside it is append-only narration.
 */

/** Quota providers whose rolling reset window an `after-reset` trigger predicts. */
export type Provider = 'claude' | 'codex';

// ── Triggers ────────────────────────────────────────────────────────────────

export type JobTriggerKind =
  | 'at'
  | 'in'
  | 'cron'
  | 'after-reset'
  | 'when-status'
  | 'when-plan-lands';

/**
 * The quota-window anchor an `after-reset` trigger predicts from. There is no
 * provider API that *proves* a reset, so v1 is honest: it predicts the next
 * reset from a user-supplied window start and re-verifies wall-clock at fire
 * time (see reset-window.ts). `reschedule` lets the user correct a bad anchor.
 */
export interface ResetAnchor {
  /** ISO timestamp of a known start of the user's current quota window. */
  windowStartIso: string;
  windowKind: 'rolling-5h' | 'weekly';
}

/**
 * A trigger is a *predicate over persisted state*, evaluated by the tick. Clock
 * triggers compare against an injected `now`; state triggers read the watched
 * assignment's append-only `statusHistory` / `planApproval` so an edge fires
 * exactly once via the per-job cursor + dedupe key — never from a live watcher.
 */
export type JobTrigger =
  | { kind: 'at'; at: string }
  | { kind: 'in'; durationMs: number; anchorIso: string }
  | { kind: 'cron'; expr: string; tz?: string }
  | { kind: 'after-reset'; provider: Provider; anchor: ResetAnchor }
  // `assignmentId` defaults to the job's own assignmentId when omitted — the AC
  // allows watching a *different* assignment ("when assignment X reaches S").
  | { kind: 'when-status'; status: string; assignmentId?: string }
  | { kind: 'when-plan-lands'; assignmentId?: string };

// ── Attempt state machine ─────────────────────────────────────────────────────

/**
 * `held` is a non-terminal pause (the tick skips it). The terminal set is
 * `TERMINAL_JOB_STATES`. `dispatch_failed` is distinct from `failed`: the
 * message never reached the chat at all (no agent attached, no dashboard, a
 * refused send).
 */
export type JobAttemptState =
  | 'eligible'
  | 'claimed'
  | 'dispatching'
  | 'running'
  | 'completed'
  | 'failed'
  | 'dispatch_failed'
  | 'held'
  | 'cancelled'
  | 'killed';

export const TERMINAL_JOB_STATES: ReadonlySet<JobAttemptState> = new Set([
  'completed',
  'failed',
  'dispatch_failed',
  'cancelled',
  'killed',
]);

export function isTerminalJobState(state: JobAttemptState): boolean {
  return TERMINAL_JOB_STATES.has(state);
}

/** A held or terminal job is never eligible for the tick to fire. */
export function isFireable(state: JobAttemptState): boolean {
  return state === 'eligible';
}

/** Advisory claim lease — mirrors the recompute.ts lockfile token discipline. */
export interface JobClaim {
  /** `pid:hash` ownership token. */
  token: string;
  /** Epoch ms after which the claim is stale and may be taken over / reaped. */
  expiresAt: number;
}

/**
 * The single authoritative mutable record per job. Persisted (atomic temp+rename)
 * inside the claimed transition BEFORE launch, so a crash post-claim/pre-launch
 * cannot refire an edge — worst case is a reapable `claimed`/`dispatching` job.
 */
export interface JobAttempt {
  state: JobAttemptState;
  /** Per-edge dedupe keys already consumed → fire-exactly-once across restarts. */
  consumedEdges: string[];
  /**
   * Cursor into the watched assignment's `statusHistory` (count of entries the
   * job has already considered). Advanced atomically with the claim.
   */
  cursor: number;
  /** Current claim lease; null when not claimed. */
  claim: JobClaim | null;
  /**
   * The chat message the dispatch minted — the ONLY handle on a dispatched
   * attempt (Decision 3). There is no session id and no pid: liveness is the
   * message's own turn state, and killing withdraws or cancels through the
   * broker.
   */
  messageId: string | null;
  /** Total accepted dispatches (feeds maxLaunchesPerDay with `launchDayStamps`). */
  dispatchCount: number;
  /** ISO day-stamps (YYYY-MM-DD) of recent dispatches, for per-day rate limiting. */
  launchDayStamps: string[];
  lastFiredAt: string | null;
  dispatchedAt: string | null;
  runningSince: string | null;
  lastError: string | null;
}

export function freshAttempt(): JobAttempt {
  return {
    state: 'eligible',
    consumedEdges: [],
    cursor: 0,
    claim: null,
    messageId: null,
    dispatchCount: 0,
    launchDayStamps: [],
    lastFiredAt: null,
    dispatchedAt: null,
    runningSince: null,
    lastError: null,
  };
}

// ── Unattended trust model ────────────────────────────────────────────────────

/**
 * Hard limits gating an unattended (non-interactive) launch — a distinct trust
 * model from an interactive launch. `null` means "no limit of this kind". The
 * kill switch is global (see unattended.ts `isKillSwitchEngaged`), not per-job.
 */
export interface UnattendedLimits {
  /** Allowed tool names for the unattended session; null = runner default. */
  toolAllowlist: string[] | null;
  maxRuntimeMs: number | null;
  maxLaunchesPerDay: number | null;
  tokenBudget: number | null;
  spendBudgetUsd: number | null;
  /** Minimum gap between two launches of THIS job. */
  cooldownMs: number | null;
}

export function defaultLimits(): UnattendedLimits {
  return {
    toolAllowlist: null,
    maxRuntimeMs: 2 * 60 * 60 * 1000, // 2h
    maxLaunchesPerDay: 4,
    tokenBudget: null,
    spendBudgetUsd: null,
    cooldownMs: 5 * 60 * 1000, // 5m
  };
}

// ── Timing invariants ─────────────────────────────────────────────────────────

/**
 * Claim/ack timing. Invariant (enforced by `assertTimingInvariant`):
 * `claimTtlMs > ackTimeoutMs + launchSlackMs` — so a job is never reaped while
 * still legitimately inside its dispatch window.
 */
export interface JobTiming {
  claimTtlMs: number;
  ackTimeoutMs: number;
  launchSlackMs: number;
}

export function defaultTiming(): JobTiming {
  return { claimTtlMs: 120_000, ackTimeoutMs: 90_000, launchSlackMs: 15_000 };
}

export function assertTimingInvariant(t: JobTiming): void {
  if (!(t.claimTtlMs > t.ackTimeoutMs + t.launchSlackMs)) {
    throw new Error(
      `Invalid job timing: claimTtlMs (${t.claimTtlMs}) must be > ackTimeoutMs (${t.ackTimeoutMs}) + launchSlackMs (${t.launchSlackMs})`,
    );
  }
}

// ── The job ───────────────────────────────────────────────────────────────────

export interface ScheduledJob {
  id: string;
  /** Target assignment whose chat the message is posted into. */
  assignmentId: string;
  /**
   * Which attached chat agent to address; null lets the assignment's default
   * agent (and any `respondsTo: all-human` participant) answer.
   */
  agentId: string | null;
  /** The message posted into the assignment's chat on every fire. */
  message: string;
  /** Unattended (non-interactive) permission mode — the distinct trust model. */
  unattended: boolean;
  limits: UnattendedLimits;
  trigger: JobTrigger;
  timing: JobTiming;
  attempt: JobAttempt;
  createdAt: string;
  updatedAt: string;
  note: string | null;
}

/** The assignment a (state) trigger watches — defaults to the job's own. */
export function watchedAssignmentId(job: ScheduledJob): string {
  const t = job.trigger;
  if (t.kind === 'when-status' || t.kind === 'when-plan-lands') {
    return t.assignmentId ?? job.assignmentId;
  }
  return job.assignmentId;
}

// ── Event log ─────────────────────────────────────────────────────────────────

export type JobEventType =
  | 'created'
  | 'fired'
  | 'claimed'
  | 'dispatching'
  | 'ack'
  | 'running'
  | 'completed'
  | 'failed'
  | 'dispatch_failed'
  | 'reaped'
  | 'held'
  | 'released'
  | 'cancelled'
  | 'killed'
  | 'rescheduled'
  | 'retried';

export interface JobEvent {
  type: JobEventType;
  at: string;
  data?: Record<string, unknown>;
}
