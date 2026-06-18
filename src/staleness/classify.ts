/**
 * Needs-attention / staleness classifier (read-only).
 *
 * The ONE place that decides whether an assignment's status has gone stale —
 * i.e. where the status CONTRADICTS reality — and why. Pure and side-effect
 * free: it never reads files, never writes status, never mutates anything. The
 * dashboard overview, the decision inbox, the CLI, and (later) a read-only
 * watchdog all feed it the same struct so the "stale" verdict is computed in
 * exactly one place and can't diverge between surfaces.
 *
 * Two hard rules (decision D1):
 *   1. Never timer-PROMOTE — this only flags, it never advances/regresses status.
 *   2. Contradiction + age, never raw age alone. An old timestamp is not
 *      staleness; an old timestamp that disagrees with activity/claim/approval
 *      is. And when an input is UNKNOWN we fail safe (do NOT flag) rather than
 *      manufacture a false positive — e.g. "no recent session" is best-effort
 *      and never fires on its own.
 */

export type StaleReasonKind =
  | 'in_progress_no_activity'
  | 'ready_unclaimed'
  | 'review_aging'
  | 'blocked_aging'
  | 'plan_awaiting_approval'
  | 'deps_unsatisfied';

export interface StaleReason {
  kind: StaleReasonKind;
  /** Human one-liner for display (dashboard/CLI). */
  label: string;
  /** Severity hint for ordering/badging. */
  severity: 'low' | 'medium' | 'high';
}

/**
 * Per-reason age gates (ms). Defaults are sensible; Task 5 lets config override
 * these keyed on disposition/phase. `deps_unsatisfied` has no age gate (a hard
 * contradiction), so it is intentionally absent here.
 */
export interface StaleThresholds {
  inProgressNoActivityMs: number;
  readyUnclaimedMs: number;
  reviewAgingMs: number;
  blockedAgingMs: number;
  planApprovalAgingMs: number;
}

const DAY = 24 * 60 * 60 * 1000;

export const DEFAULT_STALE_THRESHOLDS: StaleThresholds = {
  inProgressNoActivityMs: 7 * DAY,
  readyUnclaimedMs: 3 * DAY,
  reviewAgingMs: 3 * DAY,
  blockedAgingMs: 3 * DAY,
  planApprovalAgingMs: 3 * DAY,
};

/**
 * Merge user overrides (from the `staleness:` config block) over the defaults.
 * Defaults-first: an absent or partial config keeps every unspecified gate at
 * its default. Non-positive/non-finite overrides are ignored (defensive — the
 * config parser already validates, but a stray value must never disable a gate).
 */
export function resolveStaleThresholds(
  overrides?: Partial<StaleThresholds> | null,
): StaleThresholds {
  const merged = { ...DEFAULT_STALE_THRESHOLDS };
  if (overrides) {
    for (const key of Object.keys(merged) as (keyof StaleThresholds)[]) {
      const v = overrides[key];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) merged[key] = v;
    }
  }
  return merged;
}

export interface NeedsAttentionInput {
  /** Derived phase (draft/ready_for_planning/ready_to_implement/in_progress/review). */
  phase: string | null;
  /** Derived disposition (active/blocked/parked/terminal). */
  disposition: string | null;
  /** Resolved terminal check — caller passes the config-resolved verdict, NOT a
   * hardcoded set, so renamed terminals are honored. */
  isTerminal: boolean;
  assignee: string | null;
  blockedReason: string | null;
  /** null when unknown/not-applicable (standalone, no deps). */
  depsSatisfied: boolean | null;
  planExists: boolean;
  planApproved: boolean;
  /** ms since the last HEADLINE status change. null → no aging reason fires. */
  statusAgeMs: number | null;
  /** ms since the most recent REAL activity (max-recency of progress.md mtime,
   * workspace files, session liveness). null → unknown → activity reasons never
   * fire (fail safe). NEVER assignment `updated` (recompute bumps that). */
  lastActivityMs: number | null;
}

const PLANNING_PHASE = 'ready_for_planning';
const READY_PHASE = 'ready_to_implement';
const IN_PROGRESS_PHASE = 'in_progress';
const REVIEW_PHASE = 'review';

/**
 * Classify why (if at all) an assignment needs attention. Returns [] when the
 * status is consistent with reality (or terminal, or inputs are unknown).
 */
export function classifyNeedsAttention(
  input: NeedsAttentionInput,
  thresholds: StaleThresholds = DEFAULT_STALE_THRESHOLDS,
): StaleReason[] {
  if (input.isTerminal) return [];

  const reasons: StaleReason[] = [];
  const age = input.statusAgeMs; // null → aging gates below all fail closed
  const aged = (gate: number): boolean => age !== null && age >= gate;
  const blocked = input.disposition === 'blocked' || input.blockedReason !== null;

  // in_progress but nothing is actually happening. Requires BOTH an old status
  // AND a known-old activity signal — "no recent session" alone never fires.
  if (
    input.phase === IN_PROGRESS_PHASE &&
    !blocked &&
    aged(thresholds.inProgressNoActivityMs) &&
    input.lastActivityMs !== null &&
    input.lastActivityMs >= thresholds.inProgressNoActivityMs
  ) {
    reasons.push({
      kind: 'in_progress_no_activity',
      label: 'In progress, but no recent activity',
      severity: 'medium',
    });
  }

  // Ready to implement but nobody has claimed it.
  if (input.phase === READY_PHASE && input.assignee === null && aged(thresholds.readyUnclaimedMs)) {
    reasons.push({
      kind: 'ready_unclaimed',
      label: 'Ready to implement, unclaimed',
      severity: 'medium',
    });
  }

  // Waiting on a human review that no one has actioned.
  if (input.phase === REVIEW_PHASE && aged(thresholds.reviewAgingMs)) {
    reasons.push({ kind: 'review_aging', label: 'Awaiting review', severity: 'high' });
  }

  // Blocked and aging — the block may be stale.
  if (blocked && aged(thresholds.blockedAgingMs)) {
    reasons.push({ kind: 'blocked_aging', label: 'Blocked and aging', severity: 'high' });
  }

  // A plan exists but has sat unapproved.
  if (
    input.phase === PLANNING_PHASE &&
    input.planExists &&
    !input.planApproved &&
    aged(thresholds.planApprovalAgingMs)
  ) {
    reasons.push({
      kind: 'plan_awaiting_approval',
      label: 'Plan awaiting approval',
      severity: 'medium',
    });
  }

  // Working (or ready to work) despite unmet dependencies — a hard
  // contradiction, so no age gate. Not raised during planning (not yet
  // actionable) or when deps state is unknown (null).
  if (
    input.depsSatisfied === false &&
    (input.phase === READY_PHASE || input.phase === IN_PROGRESS_PHASE)
  ) {
    reasons.push({ kind: 'deps_unsatisfied', label: 'Unmet dependencies', severity: 'high' });
  }

  return reasons;
}
