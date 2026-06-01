import { describe, expect, it } from 'vitest';
import { matchesDateRange } from '../../dashboard/src/lib/assignmentFilter';
import { sortAssignments } from '../../dashboard/src/lib/sortAssignments';
import { isDateRange, isDateRangePreset } from '../utils/view-prefs-schema.js';
import { minimizeDateRange, expandDateRange, type DateRangeUiState } from '../../dashboard/src/lib/savedViews';

const DAY = 24 * 60 * 60 * 1000;
// Fixed "now" for deterministic preset tests.
const NOW = Date.parse('2026-06-01T12:00:00.000Z');

function item(overrides: { created?: string; updated: string }) {
  return overrides;
}

describe('matchesDateRange — presets (injected now)', () => {
  it('last_7d includes within window, excludes older and future', () => {
    const r = { field: 'updated' as const, preset: 'last_7d' as const };
    expect(matchesDateRange(item({ updated: new Date(NOW - 3 * DAY).toISOString() }), r, NOW)).toBe(true);
    expect(matchesDateRange(item({ updated: new Date(NOW - 10 * DAY).toISOString() }), r, NOW)).toBe(false);
    // Future-dated item must NOT match a "last 7 days" window.
    expect(matchesDateRange(item({ updated: new Date(NOW + 1 * DAY).toISOString() }), r, NOW)).toBe(false);
  });
  it('older_30d matches items older than 30 days only', () => {
    const r = { field: 'updated' as const, preset: 'older_30d' as const };
    expect(matchesDateRange(item({ updated: new Date(NOW - 40 * DAY).toISOString() }), r, NOW)).toBe(true);
    expect(matchesDateRange(item({ updated: new Date(NOW - 10 * DAY).toISOString() }), r, NOW)).toBe(false);
  });
});

describe('matchesDateRange — absolute local-day bounds', () => {
  // Build item + bounds from LOCAL Date constructors so the test is tz-robust.
  const localNoon = new Date(2026, 4, 15, 12, 0, 0, 0).toISOString(); // local May 15 noon
  it('from/to inclusive of the whole local day', () => {
    expect(matchesDateRange(item({ updated: localNoon }), { field: 'updated', from: '2026-05-15', to: '2026-05-15' })).toBe(true);
    expect(matchesDateRange(item({ updated: localNoon }), { field: 'updated', from: '2026-05-16' })).toBe(false);
    expect(matchesDateRange(item({ updated: localNoon }), { field: 'updated', to: '2026-05-14' })).toBe(false);
    expect(matchesDateRange(item({ updated: localNoon }), { field: 'updated', from: '2026-05-01', to: '2026-05-31' })).toBe(true);
  });
});

describe('matchesDateRange — field selection + edge cases', () => {
  it('uses created when field=created, falls back to updated when created absent', () => {
    const it1 = item({ created: new Date(NOW - 40 * DAY).toISOString(), updated: new Date(NOW - 1 * DAY).toISOString() });
    expect(matchesDateRange(it1, { field: 'created', preset: 'older_30d' }, NOW)).toBe(true);
    expect(matchesDateRange(it1, { field: 'updated', preset: 'older_30d' }, NOW)).toBe(false);
    // created absent → fall back to updated.
    expect(matchesDateRange(item({ updated: new Date(NOW - 1 * DAY).toISOString() }), { field: 'created', preset: 'last_7d' }, NOW)).toBe(true);
  });
  it('no range → matches; unparseable timestamp → excluded from any date filter', () => {
    expect(matchesDateRange(item({ updated: 'whenever' }), undefined, NOW)).toBe(true);
    expect(matchesDateRange(item({ updated: 'whenever' }), { field: 'updated', preset: 'last_7d' }, NOW)).toBe(false);
  });
});

describe('isDateRange / isDateRangePreset', () => {
  it('accepts valid shapes', () => {
    expect(isDateRange({ field: 'updated', preset: 'last_7d' })).toBe(true);
    expect(isDateRange({ field: 'created', from: '2026-05-01', to: '2026-05-31' })).toBe(true);
    expect(isDateRange({ field: 'updated' })).toBe(true);
  });
  it('rejects bad shapes', () => {
    expect(isDateRange({ field: 'nope' })).toBe(false);
    expect(isDateRange({ field: 'updated', preset: 'forever' })).toBe(false);
    expect(isDateRange({ field: 'updated', from: '05/01/2026' })).toBe(false); // not YYYY-MM-DD
    expect(isDateRange({ field: 'updated', preset: 'last_7d', from: '2026-05-01' })).toBe(false); // preset + absolute
    expect(isDateRange({ field: 'updated', bogus: 1 })).toBe(false); // unknown key
  });
  it('isDateRangePreset', () => {
    expect(isDateRangePreset('last_30d')).toBe(true);
    expect(isDateRangePreset('last_5y')).toBe(false);
  });
});

describe('sortAssignments created sort (parsed epoch, not lexical)', () => {
  const row = (id: string, created: string) => ({
    title: id, status: 'x', priority: 'medium', assignee: null, dependsOn: [] as string[],
    created, updated: created,
  });
  it('orders by actual instant even when lexical order disagrees (tz offsets)', () => {
    // a = 05:00Z, b = 00:00Z. Lexically a ("...-05:00") < b ("...Z"), but a is LATER.
    const a = row('a', '2026-01-01T00:00:00-05:00'); // 2026-01-01T05:00Z
    const b = row('b', '2026-01-01T00:00:00Z');       // 2026-01-01T00:00Z
    const asc = sortAssignments([a, b], 'created', 'asc').map((r) => r.title);
    expect(asc).toEqual(['b', 'a']); // chronological, not lexical (['a','b'])
    const desc = sortAssignments([a, b], 'created', 'desc').map((r) => r.title);
    expect(desc).toEqual(['a', 'b']);
  });
  it('missing/invalid created sorts as oldest (epoch 0)', () => {
    const valid = row('valid', '2026-01-01T00:00:00Z');
    const missing = { ...row('missing', ''), created: '' };
    expect(sortAssignments([valid, missing], 'created', 'asc').map((r) => r.title)).toEqual(['missing', 'valid']);
  });
});

describe('minimizeDateRange / expandDateRange round-trip', () => {
  it('null UI -> undefined; empty custom -> undefined', () => {
    expect(minimizeDateRange(null)).toBeUndefined();
    expect(minimizeDateRange({ field: 'updated', preset: '', from: '', to: '' })).toBeUndefined();
  });
  it('preset takes precedence over absolute', () => {
    const ui: DateRangeUiState = { field: 'created', preset: 'last_30d', from: '2026-01-01', to: '' };
    expect(minimizeDateRange(ui)).toEqual({ field: 'created', preset: 'last_30d' });
  });
  it('absolute from/to persisted when no preset', () => {
    const ui: DateRangeUiState = { field: 'updated', preset: '', from: '2026-05-01', to: '2026-05-31' };
    expect(minimizeDateRange(ui)).toEqual({ field: 'updated', from: '2026-05-01', to: '2026-05-31' });
  });
  it('expand inverts minimize', () => {
    expect(expandDateRange(undefined)).toBe(null);
    expect(expandDateRange({ field: 'created', preset: 'last_7d' })).toEqual({ field: 'created', preset: 'last_7d', from: '', to: '' });
    expect(expandDateRange({ field: 'updated', from: '2026-05-01' })).toEqual({ field: 'updated', preset: '', from: '2026-05-01', to: '' });
  });
});
