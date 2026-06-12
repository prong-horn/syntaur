import { describe, it, expect } from 'vitest';
import {
  buildUsageApiQuery,
  DEFAULT_WINDOW,
  filterSummaryLabel,
  isUsageWidgetFilters,
  isValidDateString,
  normalizeFilters,
  parseFilters,
  resolveWindow,
  serializeFilters,
  validateFilters,
  type UsageWidgetFilters,
} from '../utils/usage-filters.js';

// A fixed "now" so preset math is deterministic. 2026-06-12T08:00:00Z.
const NOW = new Date('2026-06-12T08:00:00.000Z');

describe('isValidDateString', () => {
  it('accepts real YYYY-MM-DD dates', () => {
    expect(isValidDateString('2026-06-12')).toBe(true);
    expect(isValidDateString('2024-02-29')).toBe(true); // leap day
  });
  it('rejects malformed or impossible dates', () => {
    expect(isValidDateString('2026-13-01')).toBe(false);
    expect(isValidDateString('2026-02-30')).toBe(false);
    expect(isValidDateString('2026-6-1')).toBe(false);
    expect(isValidDateString('not-a-date')).toBe(false);
    expect(isValidDateString(20260612)).toBe(false);
    expect(isValidDateString(null)).toBe(false);
  });
});

describe('resolveWindow (UTC)', () => {
  it('30d is exactly 30 inclusive days ending today', () => {
    expect(resolveWindow({ window: '30d' }, NOW)).toEqual({ since: '2026-05-14', until: '2026-06-12' });
  });
  it('defaults to 30d when window is absent', () => {
    expect(DEFAULT_WINDOW).toBe('30d');
    expect(resolveWindow({}, NOW)).toEqual({ since: '2026-05-14', until: '2026-06-12' });
  });
  it('7d and 90d windows', () => {
    expect(resolveWindow({ window: '7d' }, NOW)).toEqual({ since: '2026-06-06', until: '2026-06-12' });
    expect(resolveWindow({ window: '90d' }, NOW)).toEqual({ since: '2026-03-15', until: '2026-06-12' });
  });
  it('crosses month/year boundaries correctly', () => {
    const jan2 = new Date('2026-01-02T08:00:00.000Z');
    expect(resolveWindow({ window: '7d' }, jan2)).toEqual({ since: '2025-12-27', until: '2026-01-02' });
  });
  it('all → no bounds', () => {
    expect(resolveWindow({ window: 'all' }, NOW)).toEqual({});
  });
  it('custom passes through provided bounds', () => {
    expect(resolveWindow({ window: 'custom', since: '2026-01-01', until: '2026-02-01' }, NOW)).toEqual({
      since: '2026-01-01',
      until: '2026-02-01',
    });
  });
  it('custom with one bound is open-ended; both missing behaves like all', () => {
    expect(resolveWindow({ window: 'custom', since: '2026-01-01' }, NOW)).toEqual({ since: '2026-01-01' });
    expect(resolveWindow({ window: 'custom', until: '2026-02-01' }, NOW)).toEqual({ until: '2026-02-01' });
    expect(resolveWindow({ window: 'custom' }, NOW)).toEqual({});
  });
});

describe('validateFilters', () => {
  it('accepts empty and full valid filter sets', () => {
    expect(validateFilters({}).ok).toBe(true);
    expect(
      validateFilters({
        window: 'custom',
        since: '2026-01-01',
        until: '2026-02-01',
        project: 'p',
        workspace: 'w',
        model: 'claude-opus-4-8',
        tool: 'claude',
      }).ok,
    ).toBe(true);
  });
  it('rejects bad window, dates, since>until, and bad string fields', () => {
    expect(validateFilters({ window: '13d' }).ok).toBe(false);
    expect(validateFilters({ since: '2026-13-01' }).ok).toBe(false);
    expect(validateFilters({ window: 'custom', since: '2026-02-01', until: '2026-01-01' }).ok).toBe(false);
    expect(validateFilters({ project: '' }).ok).toBe(false);
    expect(validateFilters({ project: 5 }).ok).toBe(false);
  });
  it('rejects null/array container and null/array field values', () => {
    expect(validateFilters(null).ok).toBe(false);
    expect(validateFilters([]).ok).toBe(false);
    expect(validateFilters({ model: null }).ok).toBe(false);
    expect(validateFilters({ model: ['a'] }).ok).toBe(false);
  });
  it('ignores unknown keys (forward-compat)', () => {
    expect(validateFilters({ window: '7d', future: 'x' }).ok).toBe(true);
  });
});

describe('isUsageWidgetFilters', () => {
  it('mirrors validateFilters.ok', () => {
    expect(isUsageWidgetFilters({ window: '30d' })).toBe(true);
    expect(isUsageWidgetFilters({ window: 'nope' })).toBe(false);
  });
});

describe('normalizeFilters', () => {
  it('drops empty strings, unknown keys, and invalid values', () => {
    const out = normalizeFilters({ window: '7d', project: '', model: 'm', bogus: 1, since: 'bad' });
    expect(out).toEqual({ window: '7d', model: 'm' });
  });
  it('strips custom dates when window is not custom', () => {
    expect(normalizeFilters({ window: '30d', since: '2026-01-01', until: '2026-02-01' })).toEqual({ window: '30d' });
  });
  it('keeps custom dates when window is custom', () => {
    expect(normalizeFilters({ window: 'custom', since: '2026-01-01', until: '2026-02-01' })).toEqual({
      window: 'custom',
      since: '2026-01-01',
      until: '2026-02-01',
    });
  });
  it('returns empty object for non-object input', () => {
    expect(normalizeFilters(null)).toEqual({});
    expect(normalizeFilters([1, 2])).toEqual({});
  });
});

describe('serializeFilters / parseFilters round-trip', () => {
  const cases: UsageWidgetFilters[] = [
    {},
    { window: '7d' },
    { window: 'all', project: 'syntaur-meta' },
    { window: 'custom', since: '2026-01-01', until: '2026-02-01', model: 'claude-opus-4-8', tool: 'claude' },
    { window: '30d', workspace: 'backend' },
  ];
  for (const f of cases) {
    it(`round-trips ${JSON.stringify(f)}`, () => {
      const sp = serializeFilters(f);
      expect(parseFilters(new URLSearchParams(sp.toString()))).toEqual(normalizeFilters(f));
    });
  }
  it('does not emit custom dates for preset windows', () => {
    const sp = serializeFilters({ window: '30d', since: '2026-01-01', until: '2026-02-01' });
    expect(sp.get('since')).toBeNull();
    expect(sp.get('until')).toBeNull();
  });
});

describe('buildUsageApiQuery', () => {
  it('resolves window to concrete since/until and forwards scope', () => {
    const sp = buildUsageApiQuery({ window: '30d', project: 'p', model: 'm' }, NOW);
    expect(sp.get('since')).toBe('2026-05-14');
    expect(sp.get('until')).toBe('2026-06-12');
    expect(sp.get('project')).toBe('p');
    expect(sp.get('model')).toBe('m');
    // No `window` token leaks to the API.
    expect(sp.get('window')).toBeNull();
  });
  it('omits date bounds for the all window', () => {
    const sp = buildUsageApiQuery({ window: 'all', workspace: 'w' }, NOW);
    expect(sp.get('since')).toBeNull();
    expect(sp.get('until')).toBeNull();
    expect(sp.get('workspace')).toBe('w');
  });
});

describe('filterSummaryLabel', () => {
  it('labels presets and appended scopes', () => {
    expect(filterSummaryLabel({})).toBe('Last 30 days');
    expect(filterSummaryLabel({ window: 'all', project: 'p', model: 'm' })).toBe('All time · project: p · model: m');
    expect(filterSummaryLabel({ window: 'custom', since: '2026-01-01', until: '2026-02-01' })).toBe(
      '2026-01-01 → 2026-02-01',
    );
    expect(filterSummaryLabel({ window: '7d', workspace: 'w' })).toBe('Last 7 days · workspace: w');
  });
});
