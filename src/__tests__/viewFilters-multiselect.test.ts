import { describe, expect, it } from 'vitest';
import {
  toFilterValues,
  isFilterValue,
  sameFilterValues,
} from '../utils/view-prefs-schema.js';
import { isViewFilters } from '../utils/view-prefs-schema.js';
// Predicate lives in the dashboard lib (loads under node via the @shared alias).
import { filterAssignment } from '../../dashboard/src/lib/assignmentFilter';

describe('toFilterValues', () => {
  it('treats undefined / "all" / "" / [] / ["all"] as no constraint', () => {
    expect(toFilterValues(undefined)).toEqual([]);
    expect(toFilterValues('all')).toEqual([]);
    expect(toFilterValues('')).toEqual([]);
    expect(toFilterValues([])).toEqual([]);
    expect(toFilterValues(['all'])).toEqual([]);
  });
  it('wraps a single string into an array', () => {
    expect(toFilterValues('high')).toEqual(['high']);
  });
  it('trims, drops empty/"all", and dedupes preserving order', () => {
    expect(toFilterValues(['  a ', 'b', 'all', '', 'a'])).toEqual(['a', 'b']);
  });
});

describe('isFilterValue (trim-gated)', () => {
  it('accepts a non-empty string and rejects whitespace-only', () => {
    expect(isFilterValue('x')).toBe(true);
    expect(isFilterValue('   ')).toBe(false);
    expect(isFilterValue('')).toBe(false);
  });
  it('accepts arrays of non-empty strings, including empty array', () => {
    expect(isFilterValue(['a', 'b'])).toBe(true);
    expect(isFilterValue([])).toBe(true);
    expect(isFilterValue(['a', '  '])).toBe(false);
    expect(isFilterValue([1 as unknown as string])).toBe(false);
  });
});

describe('sameFilterValues', () => {
  it('is set-equality over normalized values', () => {
    expect(sameFilterValues(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameFilterValues('high', ['high'])).toBe(true);
    expect(sameFilterValues(undefined, [])).toBe(true);
    expect(sameFilterValues(['a'], ['a', 'b'])).toBe(false);
  });
});

describe('isViewFilters (back-compat + multi-value)', () => {
  it('accepts legacy scalar, arrays, and activity enum', () => {
    expect(isViewFilters({ status: 'in_progress' })).toBe(true);
    expect(isViewFilters({ status: ['in_progress', 'review'], type: ['feature'] })).toBe(true);
    expect(isViewFilters({ activity: 'stale' })).toBe(true);
    expect(isViewFilters({})).toBe(true);
  });
  it('rejects bad shapes', () => {
    expect(isViewFilters({ status: ['', 'x'] })).toBe(false);
    expect(isViewFilters({ status: 3 })).toBe(false);
    expect(isViewFilters({ activity: 'whenever' })).toBe(false);
  });
  it('accepts tags, search, and dateRange; rejects a bad dateRange', () => {
    expect(isViewFilters({ tags: ['backend', 'urgent'] })).toBe(true);
    expect(isViewFilters({ search: 'login' })).toBe(true);
    expect(isViewFilters({ dateRange: { field: 'updated', preset: 'last_7d' } })).toBe(true);
    expect(isViewFilters({ dateRange: { field: 'bad' } })).toBe(false);
    expect(isViewFilters({ search: 5 })).toBe(false);
    expect(isViewFilters({ tags: ['  '] })).toBe(false);
  });
  it('stays permissive about unknown forward-compat keys', () => {
    expect(isViewFilters({ status: ['x'], futureKey: 'whatever' })).toBe(true);
  });
});

describe('filterAssignment — tags (match-ANY) + dateRange', () => {
  const tagged = (tags: string[]): Item => ({ ...item(), tags });
  it('tags match-ANY: item matches if it has any selected tag', () => {
    expect(filterAssignment(tagged(['backend']), { tags: ['backend', 'urgent'] })).toBe(true);
    expect(filterAssignment(tagged(['frontend']), { tags: ['backend', 'urgent'] })).toBe(false);
    expect(filterAssignment(tagged([]), { tags: ['backend'] })).toBe(false);
    expect(filterAssignment(tagged([]), { tags: [] })).toBe(true); // empty filter = no constraint
  });
  it('dateRange flows through filterAssignment criteria (uses real now)', () => {
    const fresh: Item = { ...item(), updated: new Date(Date.now() - 1 * 86400_000).toISOString() };
    const old: Item = { ...item(), updated: new Date(Date.now() - 40 * 86400_000).toISOString() };
    expect(filterAssignment(fresh, { dateRange: { field: 'updated', preset: 'last_7d' } })).toBe(true);
    expect(filterAssignment(old, { dateRange: { field: 'updated', preset: 'last_7d' } })).toBe(false);
  });
  it('respects options.search (the path the Overview widget plumbs through)', () => {
    const i: Item = { ...item(), title: 'Fix login bug' };
    expect(filterAssignment(i, {}, { search: 'login' })).toBe(true);
    expect(filterAssignment(i, {}, { search: 'logout' })).toBe(false);
  });
});

interface Item {
  status: string;
  priority: string;
  assignee: string | null;
  type?: string | null;
  tags?: string[];
  created?: string;
  title?: string;
  updated: string;
  projectSlug?: string | null;
}
const FRESH = new Date().toISOString();
function item(p: Partial<Item> = {}): Item {
  return {
    status: 'in_progress',
    priority: 'high',
    assignee: 'claude',
    type: 'feature',
    updated: FRESH,
    projectSlug: 'alpha',
    ...p,
  };
}

describe('filterAssignment — multi-value membership', () => {
  it('empty criteria matches everything', () => {
    expect(filterAssignment(item(), {})).toBe(true);
  });
  it('legacy scalar status still matches', () => {
    expect(filterAssignment(item({ status: 'review' }), { status: 'review' })).toBe(true);
    expect(filterAssignment(item({ status: 'in_progress' }), { status: 'review' })).toBe(false);
  });
  it('OR within a field', () => {
    expect(filterAssignment(item({ status: 'review' }), { status: ['in_progress', 'review'] })).toBe(true);
    expect(filterAssignment(item({ status: 'blocked' }), { status: ['in_progress', 'review'] })).toBe(false);
  });
  it('AND across fields', () => {
    const crit = { status: ['in_progress'], priority: ['high', 'critical'] };
    expect(filterAssignment(item({ status: 'in_progress', priority: 'critical' }), crit)).toBe(true);
    expect(filterAssignment(item({ status: 'in_progress', priority: 'low' }), crit)).toBe(false);
  });
  it('honors the type field (null type → "")', () => {
    expect(filterAssignment(item({ type: 'bug' }), { type: ['bug', 'feature'] })).toBe(true);
    expect(filterAssignment(item({ type: null }), { type: ['feature'] })).toBe(false);
  });
  it('__unassigned__ matches null assignee inside an array', () => {
    expect(filterAssignment(item({ assignee: null }), { assignee: ['__unassigned__', 'bob'] })).toBe(true);
    expect(filterAssignment(item({ assignee: 'claude' }), { assignee: ['__unassigned__'] })).toBe(false);
  });
  it('__standalone__ matches null projectSlug inside an array (OR with real slugs)', () => {
    expect(filterAssignment(item({ projectSlug: null }), { project: ['__standalone__', 'beta'] })).toBe(true);
    expect(filterAssignment(item({ projectSlug: 'alpha' }), { project: ['__standalone__', 'beta'] })).toBe(false);
    expect(filterAssignment(item({ projectSlug: 'beta' }), { project: ['__standalone__', 'beta'] })).toBe(true);
  });
  it('activity still works alongside multi-value fields', () => {
    const old = new Date(Date.now() - 30 * 86400_000).toISOString();
    expect(filterAssignment(item({ updated: old }), { activity: 'stale' })).toBe(true);
    expect(filterAssignment(item({ updated: FRESH }), { activity: 'stale' })).toBe(false);
  });
});

