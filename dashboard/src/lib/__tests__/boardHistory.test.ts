import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OLDER_THAN_DAYS,
  filterByHistoryMode,
  isBoardTerminal,
  normalizeHistoryMode,
  normalizeOlderThanDays,
} from '../boardHistory';

const NOW = new Date('2026-09-18T12:00:00.000Z');

function daysAgo(n: number): string {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString();
}

describe('boardHistory', () => {
  it('normalizes history mode and olderThanDays', () => {
    expect(normalizeHistoryMode(null)).toBe('recent');
    expect(normalizeHistoryMode('all')).toBe('all');
    expect(normalizeOlderThanDays(null)).toBe(DEFAULT_OLDER_THAN_DAYS);
    expect(normalizeOlderThanDays('abc')).toBe(DEFAULT_OLDER_THAN_DAYS);
    expect(normalizeOlderThanDays('45')).toBe(45);
  });

  it('treats done and dropped as terminal', () => {
    expect(isBoardTerminal('done')).toBe(true);
    expect(isBoardTerminal('dropped')).toBe(true);
    expect(isBoardTerminal('in_progress')).toBe(false);
  });

  it('recent keeps active, recent terminal, and unknown completion dates', () => {
    const items = [
      { id: 'a', status: 'in_progress', completedAt: null },
      { id: 'b', status: 'done', completedAt: daysAgo(10) },
      { id: 'c', status: 'done', completedAt: daysAgo(40) },
      { id: 'd', status: 'dropped', completedAt: null },
      { id: 'e', status: 'dropped', completedAt: 'not-a-date' },
    ];
    const out = filterByHistoryMode(items, 'recent', 30, NOW);
    expect(out.map((i) => i.id)).toEqual(['a', 'b', 'd', 'e']);
  });

  it('older shows only terminal tickets strictly past the cutoff', () => {
    const items = [
      { id: 'a', status: 'done', completedAt: daysAgo(30) },
      { id: 'b', status: 'done', completedAt: daysAgo(31) },
      { id: 'c', status: 'done', completedAt: null },
      { id: 'd', status: 'in_progress', completedAt: null },
    ];
    const out = filterByHistoryMode(items, 'older', 30, NOW);
    expect(out.map((i) => i.id)).toEqual(['b']);
  });

  it('all includes every ticket', () => {
    const items = [
      { id: 'a', status: 'in_progress', completedAt: null },
      { id: 'b', status: 'done', completedAt: daysAgo(100) },
    ];
    expect(filterByHistoryMode(items, 'all', 30, NOW)).toHaveLength(2);
  });

  it('reopen semantics: non-terminal passes recent filter even with old completedAt', () => {
    const items = [{ id: 'a', status: 'in_progress', completedAt: daysAgo(90) }];
    expect(filterByHistoryMode(items, 'recent', 30, NOW)).toHaveLength(1);
    expect(filterByHistoryMode(items, 'older', 30, NOW)).toHaveLength(0);
  });
});
