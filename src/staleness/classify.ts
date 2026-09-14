/**
 * Needs-attention / staleness classifier (read-only) — v2 stages + flags.
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
  label: string;
  severity: 'low' | 'medium' | 'high';
}

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
  /** v2 stage id (backlog, planning, ready, in_progress, review, done, dropped). */
  stage: string | null;
  isTerminal: boolean;
  assignee: string | null;
  blocked: string | null;
  depsSatisfied: boolean | null;
  planExists: boolean;
  planApproved: boolean;
  statusAgeMs: number | null;
  lastActivityMs: number | null;
}

export function classifyNeedsAttention(
  input: NeedsAttentionInput,
  thresholds: StaleThresholds = DEFAULT_STALE_THRESHOLDS,
): StaleReason[] {
  if (input.isTerminal) return [];

  const reasons: StaleReason[] = [];
  const age = input.statusAgeMs;
  const aged = (gate: number): boolean => age !== null && age >= gate;
  const blocked = Boolean(input.blocked);

  if (
    input.stage === 'in_progress' &&
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

  if (input.stage === 'ready' && input.assignee === null && aged(thresholds.readyUnclaimedMs)) {
    reasons.push({
      kind: 'ready_unclaimed',
      label: 'Ready, unclaimed',
      severity: 'medium',
    });
  }

  if (input.stage === 'review' && aged(thresholds.reviewAgingMs)) {
    reasons.push({ kind: 'review_aging', label: 'Awaiting review', severity: 'high' });
  }

  if (blocked && aged(thresholds.blockedAgingMs)) {
    reasons.push({ kind: 'blocked_aging', label: 'Blocked and aging', severity: 'high' });
  }

  if (
    input.stage === 'planning' &&
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

  if (
    input.depsSatisfied === false &&
    (input.stage === 'ready' || input.stage === 'in_progress')
  ) {
    reasons.push({ kind: 'deps_unsatisfied', label: 'Unmet dependencies', severity: 'high' });
  }

  return reasons;
}
