import { describe, it, expect } from 'vitest';
import {
  defaultTransitions,
  filterToStatuses,
  filterValidTransitions,
  groupTransitions,
  toEditableTransitions,
  fromEditableTransitions,
  validateTransitions,
} from '../../dashboard/src/pages/transitions-helpers';
import { DEFAULT_TRANSITION_TABLE } from '../lifecycle/state-machine.js';

describe('defaultTransitions', () => {
  it('expands DEFAULT_TRANSITION_TABLE into from/command/to rows', () => {
    const rows = defaultTransitions();
    expect(rows.length).toBe(DEFAULT_TRANSITION_TABLE.size);
    const start = rows.find((r) => r.from === 'pending' && r.command === 'start');
    expect(start?.to).toBe('in_progress');
  });

  it('splits commands containing hyphens correctly (plan-ready)', () => {
    const row = defaultTransitions().find((r) => r.command === 'plan-ready');
    expect(row).toBeDefined();
    expect(row!.from).toBe('ready_for_planning');
    expect(row!.to).toBe('ready_to_implement');
  });
});

describe('filterToStatuses', () => {
  it('keeps only rows whose `from` is a defined status', () => {
    const rows = defaultTransitions();
    const filtered = filterToStatuses(rows, new Set(['in_progress', 'review']));
    expect(filtered.every((r) => r.from === 'in_progress' || r.from === 'review')).toBe(true);
    // none of the dropped `from`s (pending, draft, …) survive
    expect(filtered.some((r) => r.from === 'pending')).toBe(false);
  });
});

describe('filterValidTransitions (P1-1)', () => {
  it('drops rows whose `to` is undefined even when `from` is defined', () => {
    const rows = [
      { from: 'in_progress', command: 'block', to: 'blocked' },
      { from: 'in_progress', command: 'review', to: 'review' }, // `review` not defined
    ];
    const out = filterValidTransitions(rows, new Set(['in_progress', 'blocked']));
    expect(out).toEqual([{ from: 'in_progress', command: 'block', to: 'blocked' }]);
  });

  it('the built-in defaults filtered to a 3-status set never reference an undefined status', () => {
    const ids = new Set(['in_progress', 'blocked', 'completed']);
    const out = filterValidTransitions(defaultTransitions(), ids);
    expect(out.every((r) => ids.has(r.from) && ids.has(r.to))).toBe(true);
  });
});

describe('groupTransitions', () => {
  it('groups by from preserving first-seen order', () => {
    const groups = groupTransitions([
      { from: 'a', command: 'x', to: 'b' },
      { from: 'b', command: 'y', to: 'a' },
      { from: 'a', command: 'z', to: 'b' },
    ]);
    expect(groups.map((g) => g.from)).toEqual(['a', 'b']);
    expect(groups[0].rows).toHaveLength(2);
  });
});

describe('toEditableTransitions / fromEditableTransitions', () => {
  it('round-trips, dropping empty optionals and unset requiresReason', () => {
    const wire = [{ from: 'in_progress', command: 'block', to: 'blocked', requiresReason: true, label: 'Block' }];
    const editable = toEditableTransitions(wire);
    expect(editable[0].rowKey).toBeTruthy();
    const back = fromEditableTransitions(editable);
    expect(back).toEqual([{ from: 'in_progress', command: 'block', to: 'blocked', label: 'Block', requiresReason: true }]);
  });

  it('omits requiresReason when false and empty label/description', () => {
    const editable = toEditableTransitions([{ from: 'a', command: 'x', to: 'b' }]);
    expect(fromEditableTransitions(editable)).toEqual([{ from: 'a', command: 'x', to: 'b' }]);
  });
});

describe('validateTransitions', () => {
  const ids = new Set(['in_progress', 'blocked']);
  it('passes when from/to are defined', () => {
    const rows = toEditableTransitions([{ from: 'in_progress', command: 'block', to: 'blocked' }]);
    expect(validateTransitions(rows, ids)).toEqual([]);
  });
  it('flags an unknown from and an unknown to', () => {
    const rows = toEditableTransitions([{ from: 'ghost', command: 'x', to: 'phantom' }]);
    const problems = validateTransitions(rows, ids);
    expect(problems.some((p) => p.includes('ghost'))).toBe(true);
    expect(problems.some((p) => p.includes('phantom'))).toBe(true);
  });
});
