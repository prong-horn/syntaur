import { describe, it, expect } from 'vitest';
import {
  defaultTransitions,
  toEditableTransitions,
  makeTransitionRowKey,
  collectTransitionIssues,
  type EditableTransition,
  type StatusOption,
} from '../transitions-helpers';

function row(
  from: string,
  command: string,
  to: string,
  extra: Partial<EditableTransition> = {},
): EditableTransition {
  return {
    rowKey: makeTransitionRowKey(),
    from,
    command,
    to,
    label: '',
    description: '',
    requiresReason: false,
    ...extra,
  };
}

function status(id: string, extra: Partial<StatusOption> = {}): StatusOption {
  return { id, label: id, ...extra };
}

// Same live-ish set used in transitions-helpers.test.ts: no `pending`; planning /
// code_review / parked defined but unreachable under the default table.
const LIVE_STATUSES: StatusOption[] = [
  status('draft'),
  status('ready_for_planning'),
  status('ready_to_implement'),
  status('planning'),
  status('in_progress'),
  status('code_review'),
  status('review'),
  status('blocked'),
  status('completed', { terminal: true }),
  status('failed', { terminal: true }),
  status('parked'),
];

describe('collectTransitionIssues', () => {
  it('returns no issues for a clean, fully-reachable workflow', () => {
    const statuses = [status('draft'), status('in_progress'), status('completed', { terminal: true })];
    const rows = [row('draft', 'start', 'in_progress'), row('in_progress', 'complete', 'completed')];
    expect(collectTransitionIssues(rows, statuses)).toEqual([]);
  });

  it('emits an undefined-ref issue carrying the row rowKey and the missing statusId', () => {
    const statuses = [status('draft'), status('in_progress')];
    const r = row('pending', 'start', 'in_progress');
    const issues = collectTransitionIssues([r], statuses);
    const undef = issues.filter((i) => i.kind === 'undefined-ref');
    expect(undef).toHaveLength(1);
    expect(undef[0].rowKey).toBe(r.rowKey);
    expect(undef[0].statusId).toBe('pending');
    expect(undef[0].message).toContain('pending');
  });

  it('dedupes a self-loop on an undefined status into a single undefined-ref issue', () => {
    const issues = collectTransitionIssues([row('ghost', 'loop', 'ghost')], [status('draft')]);
    const undef = issues.filter((i) => i.kind === 'undefined-ref');
    expect(undef).toHaveLength(1);
    expect(undef[0].statusId).toBe('ghost');
  });

  it('emits an orphan-status issue carrying the statusId and no rowKey', () => {
    const statuses = [status('draft'), status('in_progress'), status('parked')];
    const issues = collectTransitionIssues([row('draft', 'start', 'in_progress')], statuses);
    const orphan = issues.filter((i) => i.kind === 'orphan-status');
    expect(orphan).toHaveLength(1);
    expect(orphan[0].statusId).toBe('parked');
    expect(orphan[0].rowKey).toBeUndefined();
    expect(orphan[0].message).toContain('parked');
  });

  it('reports both undefined refs and orphans for the live status set + default table', () => {
    const rows = toEditableTransitions(defaultTransitions());
    const issues = collectTransitionIssues(rows, LIVE_STATUSES);

    const undefStatusIds = issues.filter((i) => i.kind === 'undefined-ref').map((i) => i.statusId);
    expect(undefStatusIds.filter((id) => id === 'pending')).toHaveLength(2); // pending:start, pending:block

    const orphanIds = new Set(
      issues.filter((i) => i.kind === 'orphan-status').map((i) => i.statusId),
    );
    expect(orphanIds.has('planning')).toBe(true);
    expect(orphanIds.has('code_review')).toBe(true);
    expect(orphanIds.has('parked')).toBe(true);
    // Entry/reachable statuses are never orphan-flagged.
    expect(orphanIds.has('draft')).toBe(false);
    expect(orphanIds.has('in_progress')).toBe(false);
  });
});
