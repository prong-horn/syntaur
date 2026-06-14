import { describe, expect, it } from 'vitest';
import { tabProblemSummary } from '../../dashboard/src/pages/workflow-page-helpers';

describe('tabProblemSummary', () => {
  it('reports no offending tabs when every count is zero', () => {
    const summary = tabProblemSummary({ transitions: 0, derive: 0, facts: 0 });
    expect(summary.total).toBe(0);
    expect(summary.offending).toEqual([]);
    expect(summary.message).toBe('Unsaved changes');
  });

  it('names the single offending tab with its count', () => {
    const summary = tabProblemSummary({ transitions: 0, derive: 2, facts: 0 });
    expect(summary.total).toBe(2);
    expect(summary.offending).toEqual([{ tab: 'Derive Rules', count: 2 }]);
    expect(summary.message).toBe('Fix errors in Derive Rules to save');
  });

  it('lists multiple offending tabs in tab order with a combined total', () => {
    const summary = tabProblemSummary({ transitions: 1, derive: 2, facts: 3 });
    expect(summary.total).toBe(6);
    expect(summary.offending).toEqual([
      { tab: 'Transitions', count: 1 },
      { tab: 'Derive Rules', count: 2 },
      { tab: 'Facts', count: 3 },
    ]);
    expect(summary.offending.map((o) => o.tab)).toEqual(['Transitions', 'Derive Rules', 'Facts']);
    expect(summary.message).toBe('Fix errors in Transitions, Derive Rules, Facts to save');
  });

  it('never names Statuses, even when all tracked tabs have problems', () => {
    const summary = tabProblemSummary({ transitions: 4, derive: 5, facts: 6 });
    expect(summary.offending.some((o) => /status/i.test(o.tab))).toBe(false);
    expect(summary.message).not.toMatch(/status/i);
  });
});
