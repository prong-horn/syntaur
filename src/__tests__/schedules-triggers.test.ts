import { describe, expect, it } from 'vitest';
import { evaluateTrigger } from '../schedules/triggers.js';
import { sampleJob, sampleAssignment, statusEntry } from './schedules-helpers.js';

describe('trigger evaluation', () => {
  // tz pinned to UTC so the assertion is independent of the CI machine timezone.
  // (Production default is the machine's local tz: "run at 3am" means the user's
  // 3am; a tz override makes it explicit.)
  it('cron: computes next-fire and is due at an occurrence with a frozen clock', () => {
    const job = sampleJob({ trigger: { kind: 'cron', expr: '0 3 * * *', tz: 'UTC' } });
    const now = new Date('2026-06-15T03:00:00Z');
    const e = evaluateTrigger(job, { now });
    expect(e.due).toBe(true);
    expect(e.dedupeKey).toBe('cron:2026-06-15T03:00:00Z');
    expect(e.nextFireIso).toBe('2026-06-16T03:00:00Z');
  });

  it('cron: the most-recent prior occurrence is the due edge', () => {
    // Created well before the occurrence, so the creation baseline allows it.
    const job = sampleJob({ trigger: { kind: 'cron', expr: '0 3 * * *', tz: 'UTC' }, createdAt: '2026-06-01T00:00:00Z' });
    // 02:59 → most recent prior 03:00 is the day before.
    const before = evaluateTrigger(job, { now: new Date('2026-06-15T02:59:00Z') });
    expect(before.dedupeKey).toBe('cron:2026-06-14T03:00:00Z');
    expect(before.nextFireIso).toBe('2026-06-15T03:00:00Z');
  });

  // Codex P0: a newly-created schedule must react only to FUTURE edges.
  it('cron: does NOT backfire an occurrence that predates creation', () => {
    // Created at 16:00; today's 03:00 already passed → must not fire on it.
    const job = sampleJob({ trigger: { kind: 'cron', expr: '0 3 * * *', tz: 'UTC' }, createdAt: '2026-06-15T16:00:00Z' });
    const e = evaluateTrigger(job, { now: new Date('2026-06-15T16:30:00Z') });
    expect(e.due).toBe(false);
    expect(e.nextFireIso).toBe('2026-06-16T03:00:00Z'); // fires tomorrow, not now
  });

  it('when-status: does NOT fire on a transition that predates creation', () => {
    const job = sampleJob({ trigger: { kind: 'when-status', status: 'ready_to_implement' }, createdAt: '2026-06-15T05:00:00Z' });
    const assignment = sampleAssignment({
      statusHistory: [statusEntry('ready_to_implement', '2026-06-15T02:00:00Z')], // before creation
    });
    expect(evaluateTrigger(job, { now: new Date('2026-06-15T06:00:00Z'), assignment }).due).toBe(false);
  });

  it('when-plan-lands: does NOT fire on an approval that predates creation', () => {
    const job = sampleJob({ trigger: { kind: 'when-plan-lands' }, createdAt: '2026-06-15T06:00:00Z' });
    const approved = sampleAssignment({
      planApproval: { file: 'plan.md', digest: 'abc', by: 'claude', at: '2026-06-15T05:00:00Z' }, // before creation
    });
    expect(evaluateTrigger(job, { now: new Date('2026-06-15T07:00:00Z'), assignment: approved }).due).toBe(false);
  });

  it('at / in: due once the time passes', () => {
    const at = sampleJob({ trigger: { kind: 'at', at: '2026-06-15T12:00:00Z' } });
    expect(evaluateTrigger(at, { now: new Date('2026-06-15T11:59:00Z') }).due).toBe(false);
    expect(evaluateTrigger(at, { now: new Date('2026-06-15T12:00:00Z') }).due).toBe(true);

    const inJob = sampleJob({ trigger: { kind: 'in', durationMs: 3_600_000, anchorIso: '2026-06-15T00:00:00Z' } });
    expect(evaluateTrigger(inJob, { now: new Date('2026-06-15T00:59:00Z') }).due).toBe(false);
    expect(evaluateTrigger(inJob, { now: new Date('2026-06-15T01:00:00Z') }).due).toBe(true);
  });

  it('after-reset: reschedules before, due after', () => {
    const job = sampleJob({
      trigger: { kind: 'after-reset', provider: 'claude', anchor: { windowStartIso: '2026-06-15T09:00:00Z', windowKind: 'rolling-5h' } },
    });
    const before = evaluateTrigger(job, { now: new Date('2026-06-15T13:00:00Z') });
    expect(before.due).toBe(false);
    expect(before.rescheduleToIso).toBe('2026-06-15T14:00:00Z');
    expect(evaluateTrigger(job, { now: new Date('2026-06-15T14:00:00Z') }).due).toBe(true);
  });

  it('when-status: fires once on the matching transition and advances the cursor', () => {
    const job = sampleJob({ trigger: { kind: 'when-status', status: 'ready_to_implement' } });
    const assignment = sampleAssignment({
      statusHistory: [
        statusEntry('ready_for_planning', '2026-06-15T01:00:00Z'),
        statusEntry('ready_to_implement', '2026-06-15T02:00:00Z'),
      ],
    });
    const e = evaluateTrigger(job, { now: new Date('2026-06-15T03:00:00Z'), assignment });
    expect(e.due).toBe(true);
    expect(e.dedupeKey).toBe('status:1:2026-06-15T02:00:00Z');
    expect(e.nextCursor).toBe(2);
  });

  it('when-status: fails closed when the assignment cannot be read', () => {
    const job = sampleJob({ trigger: { kind: 'when-status', status: 'completed' } });
    expect(evaluateTrigger(job, { now: new Date(), assignment: null }).due).toBe(false);
  });

  it('when-plan-lands: fires only once planApproval is non-null', () => {
    const job = sampleJob({ trigger: { kind: 'when-plan-lands' } });
    const noApproval = sampleAssignment({ planApproval: null });
    expect(evaluateTrigger(job, { now: new Date(), assignment: noApproval }).due).toBe(false);

    const approved = sampleAssignment({
      planApproval: { file: 'plan.md', digest: 'abc123', by: 'claude', at: '2026-06-15T05:00:00Z' },
    });
    const e = evaluateTrigger(job, { now: new Date(), assignment: approved });
    expect(e.due).toBe(true);
    expect(e.dedupeKey).toBe('plan:plan.md:abc123');
  });

  it('does not re-fire an edge whose dedupe key is already consumed (crash-safe)', () => {
    const job = sampleJob({
      trigger: { kind: 'at', at: '2026-06-15T12:00:00Z' },
      attempt: { ...sampleJob().attempt, consumedEdges: ['at:2026-06-15T12:00:00Z'] },
    });
    const e = evaluateTrigger(job, { now: new Date('2026-06-15T13:00:00Z') });
    expect(e.due).toBe(false);
  });
});
