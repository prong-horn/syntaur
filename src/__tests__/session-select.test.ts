import { describe, it, expect } from 'vitest';
import { selectableSessionIds, headerCheckState } from '../utils/session-select.js';

describe('selectableSessionIds', () => {
  it('excludes usage-only rows', () => {
    expect(
      selectableSessionIds([
        { sessionId: 'a' },
        { sessionId: 'b', usageOnly: true },
        { sessionId: 'c', usageOnly: false },
      ]),
    ).toEqual(['a', 'c']);
  });

  it('returns empty for an all-usage-only list', () => {
    expect(
      selectableSessionIds([
        { sessionId: 'a', usageOnly: true },
        { sessionId: 'b', usageOnly: true },
      ]),
    ).toEqual([]);
  });

  it('returns empty for an empty list', () => {
    expect(selectableSessionIds([])).toEqual([]);
  });
});

describe('headerCheckState', () => {
  const rows = [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c', usageOnly: true }];

  it('is none when nothing is selected', () => {
    expect(headerCheckState(rows, new Set())).toBe('none');
  });

  it('is some on a partial selection', () => {
    expect(headerCheckState(rows, new Set(['a']))).toBe('some');
  });

  it('is all when every SELECTABLE row is selected, ignoring usage-only rows', () => {
    // 'c' is usage-only and can never be selected, so a/b selected is "all".
    expect(headerCheckState(rows, new Set(['a', 'b']))).toBe('all');
  });

  it('is none for an all-usage-only list rather than vacuously all', () => {
    expect(headerCheckState([{ sessionId: 'x', usageOnly: true }], new Set())).toBe('none');
  });

  it('ignores selected ids that are no longer in the list', () => {
    expect(headerCheckState(rows, new Set(['a', 'b', 'gone']))).toBe('all');
  });
});
