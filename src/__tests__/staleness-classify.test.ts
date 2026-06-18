import { describe, expect, it } from 'vitest';
import {
  classifyNeedsAttention,
  DEFAULT_STALE_THRESHOLDS,
  type NeedsAttentionInput,
} from '../staleness/classify.js';

const DAY = 24 * 60 * 60 * 1000;

function base(overrides: Partial<NeedsAttentionInput> = {}): NeedsAttentionInput {
  return {
    phase: 'in_progress',
    disposition: 'active',
    isTerminal: false,
    assignee: 'claude',
    blockedReason: null,
    depsSatisfied: true,
    planExists: true,
    planApproved: true,
    statusAgeMs: 30 * DAY,
    lastActivityMs: 30 * DAY,
    ...overrides,
  };
}

function kinds(input: NeedsAttentionInput): string[] {
  return classifyNeedsAttention(input, DEFAULT_STALE_THRESHOLDS).map((r) => r.kind);
}

describe('classifyNeedsAttention (contradiction-based, fail-safe)', () => {
  it('terminal assignments are never stale', () => {
    expect(kinds(base({ isTerminal: true }))).toEqual([]);
  });

  it('in_progress with old status AND old activity → in_progress_no_activity', () => {
    expect(kinds(base({ phase: 'in_progress', statusAgeMs: 30 * DAY, lastActivityMs: 30 * DAY }))).toContain(
      'in_progress_no_activity',
    );
  });

  it('in_progress with RECENT activity → not stale (activity wins)', () => {
    expect(kinds(base({ phase: 'in_progress', statusAgeMs: 30 * DAY, lastActivityMs: 1 * DAY }))).not.toContain(
      'in_progress_no_activity',
    );
  });

  it('in_progress with UNKNOWN activity (null) → never fires (fail-safe; recency alone never fires)', () => {
    expect(kinds(base({ phase: 'in_progress', statusAgeMs: 30 * DAY, lastActivityMs: null }))).not.toContain(
      'in_progress_no_activity',
    );
  });

  it('in_progress but young status age → not stale (age gate)', () => {
    expect(kinds(base({ phase: 'in_progress', statusAgeMs: 1 * DAY, lastActivityMs: 30 * DAY }))).not.toContain(
      'in_progress_no_activity',
    );
  });

  it('ready_to_implement + unclaimed + old → ready_unclaimed', () => {
    expect(kinds(base({ phase: 'ready_to_implement', assignee: null, statusAgeMs: 10 * DAY }))).toContain(
      'ready_unclaimed',
    );
  });

  it('ready_to_implement + claimed → not ready_unclaimed', () => {
    expect(kinds(base({ phase: 'ready_to_implement', assignee: 'claude', statusAgeMs: 10 * DAY }))).not.toContain(
      'ready_unclaimed',
    );
  });

  it('review aging', () => {
    expect(kinds(base({ phase: 'review', statusAgeMs: 10 * DAY }))).toContain('review_aging');
  });

  it('blocked aging keys on blockedReason/disposition', () => {
    expect(
      kinds(base({ phase: 'in_progress', disposition: 'blocked', blockedReason: 'waiting on infra', statusAgeMs: 10 * DAY })),
    ).toContain('blocked_aging');
  });

  it('plan awaiting approval: ready_for_planning + plan exists + unapproved + old', () => {
    expect(
      kinds(base({ phase: 'ready_for_planning', planExists: true, planApproved: false, statusAgeMs: 10 * DAY })),
    ).toContain('plan_awaiting_approval');
  });

  it('no plan_awaiting_approval when the plan is already approved', () => {
    expect(
      kinds(base({ phase: 'ready_for_planning', planExists: true, planApproved: true, statusAgeMs: 10 * DAY })),
    ).not.toContain('plan_awaiting_approval');
  });

  it('deps unsatisfied while ready/in_progress → deps_unsatisfied (no age gate)', () => {
    expect(kinds(base({ phase: 'in_progress', depsSatisfied: false, statusAgeMs: 0 }))).toContain('deps_unsatisfied');
    expect(kinds(base({ phase: 'ready_to_implement', depsSatisfied: false, statusAgeMs: 0 }))).toContain(
      'deps_unsatisfied',
    );
  });

  it('deps unsatisfied during planning does NOT fire (not yet actionable)', () => {
    expect(kinds(base({ phase: 'ready_for_planning', depsSatisfied: false, statusAgeMs: 0 }))).not.toContain(
      'deps_unsatisfied',
    );
  });

  it('null statusAge → no aging-based reasons (fail-safe)', () => {
    expect(kinds(base({ phase: 'review', statusAgeMs: null }))).toEqual([]);
  });

  it('every reason carries a human label', () => {
    const reasons = classifyNeedsAttention(
      base({ phase: 'review', statusAgeMs: 10 * DAY }),
      DEFAULT_STALE_THRESHOLDS,
    );
    expect(reasons.length).toBeGreaterThan(0);
    for (const r of reasons) expect(r.label.length).toBeGreaterThan(0);
  });
});
