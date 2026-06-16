/**
 * Type model for the scheduled-agents feature (see the assignment's plan.md).
 *
 * A `ScheduledJob` persists **intent** (which assignment, which agent, which
 * prompt/playbook, which trigger, what unattended limits) — never a resolved
 * execution spec. The cwd/worktree/prompt are recomputed at fire time by the
 * tick via `resolveLaunchPlan`, so a job survives the assignment moving branches
 * or worktrees.
 *
 * The store is per-file + markdown frontmatter (auditable like an assignment),
 * NOT SQLite — a deliberate divergence from the leases/sessions precedent
 * because a schedule is an intent-as-document a human edits and reviews. All
 * mutable attempt state lives in the job file's frontmatter (one authoritative
 * record per job); the JSONL event log alongside it is append-only narration.
 */

import type { TerminalChoice } from '../utils/config.js';

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
 * `TERMINAL_JOB_STATES`. `launch_failed` is distinct from `failed`: the wrapper
 * spawned but no agent ack arrived within the launch-ack window.
 */
export type JobAttemptState =
  | 'eligible'
  | 'claimed'
  | 'launching'
  | 'running'
  | 'completed'
  | 'failed'
  | 'launch_failed'
  | 'held'
  | 'cancelled'
  | 'killed';

export const TERMINAL_JOB_STATES: ReadonlySet<JobAttemptState> = new Set([
  'completed',
  'failed',
  'launch_failed',
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
 * cannot refire an edge — worst case is a reapable `claimed`/`launching` job.
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
  /** Tracked session id linked at launch-ack; null until `running`. */
  sessionId: string | null;
  /** Wrapper/agent pid captured from the LaunchHandle; null until launched. */
  launchPid: number | null;
  /** Total successful launches (feeds maxLaunchesPerDay with `launchDayStamps`). */
  launchCount: number;
  /** ISO day-stamps (YYYY-MM-DD) of recent launches, for per-day rate limiting. */
  launchDayStamps: string[];
  lastFiredAt: string | null;
  launchingSince: string | null;
  runningSince: string | null;
  lastError: string | null;
}

export function freshAttempt(): JobAttempt {
  return {
    state: 'eligible',
    consumedEdges: [],
    cursor: 0,
    claim: null,
    sessionId: null,
    launchPid: null,
    launchCount: 0,
    launchDayStamps: [],
    lastFiredAt: null,
    launchingSince: null,
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
 * still legitimately inside its launch-ack window.
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
  /** Target assignment the launched agent works on. */
  assignmentId: string;
  agentId: string;
  /** Launch-prompt template; null when a playbook drives the prompt. */
  promptTemplate: string | null;
  /** Playbook slug; null when `promptTemplate` drives the prompt. */
  playbook: string | null;
  /** Terminal to launch in; null = user's configured default at fire time. */
  terminalPreference: TerminalChoice | null;
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
  | 'launching'
  | 'ack'
  | 'running'
  | 'completed'
  | 'failed'
  | 'launch_failed'
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
