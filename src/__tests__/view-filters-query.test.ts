import { describe, it, expect } from 'vitest';
import {
  quoteQueryValue,
  viewFiltersToQuery,
  queryToViewFilters,
  normalizeChipFilters,
} from '../utils/view-filters-query.js';
import type { ViewFilters } from '../utils/view-prefs-schema.js';

// ── quoteQueryValue ──────────────────────────────────────────────────────────
// A value is emitted UNQUOTED only when it matches the lexer IDENT pattern
// (^[A-Za-z_][A-Za-z0-9_-]*$) AND is not a keyword (and/or/not). Otherwise it is
// double-quoted with `\` and `"` escaped.
describe('quoteQueryValue', () => {
  it('leaves a bare identifier unquoted', () => {
    expect(quoteQueryValue('in_progress')).toBe('in_progress');
    expect(quoteQueryValue('feature')).toBe('feature');
    expect(quoteQueryValue('high')).toBe('high');
    expect(quoteQueryValue('my-project')).toBe('my-project'); // hyphen allowed mid-ident
    expect(quoteQueryValue('_internal')).toBe('_internal');
  });

  it('quotes values containing a colon (actor ids)', () => {
    expect(quoteQueryValue('agent:codex')).toBe('"agent:codex"');
    expect(quoteQueryValue('human:brennen')).toBe('"human:brennen"');
  });

  it('quotes values with spaces', () => {
    expect(quoteQueryValue('two words')).toBe('"two words"');
  });

  it('quotes values with a leading digit', () => {
    expect(quoteQueryValue('123abc')).toBe('"123abc"');
    expect(quoteQueryValue('2026-06-01')).toBe('"2026-06-01"');
  });

  it('quotes a leading hyphen (not a valid IDENT start)', () => {
    expect(quoteQueryValue('-foo')).toBe('"-foo"');
  });

  it('quotes keywords case-insensitively', () => {
    expect(quoteQueryValue('and')).toBe('"and"');
    expect(quoteQueryValue('or')).toBe('"or"');
    expect(quoteQueryValue('not')).toBe('"not"');
    expect(quoteQueryValue('AND')).toBe('"AND"');
    expect(quoteQueryValue('Not')).toBe('"Not"');
  });

  it('escapes embedded backslash and double-quote', () => {
    expect(quoteQueryValue('a"b')).toBe('"a\\"b"');
    expect(quoteQueryValue('a\\b')).toBe('"a\\\\b"');
    expect(quoteQueryValue('both " and \\')).toBe('"both \\" and \\\\"');
  });

  it('quotes the empty string', () => {
    expect(quoteQueryValue('')).toBe('""');
  });
});

// ── viewFiltersToQuery: empty ────────────────────────────────────────────────
describe('viewFiltersToQuery — no constraints', () => {
  it('returns empty string for {}', () => {
    expect(viewFiltersToQuery({})).toBe('');
  });
  it('returns empty string for all-"all" filters', () => {
    expect(
      viewFiltersToQuery({
        status: 'all',
        type: 'all',
        priority: 'all',
        assignee: 'all',
        project: 'all',
        activity: 'all',
      }),
    ).toBe('');
  });
  it('returns empty string for empty arrays / blank search', () => {
    expect(viewFiltersToQuery({ status: [], tags: [], search: '   ' })).toBe('');
  });
});

// ── viewFiltersToQuery: single emission shapes ───────────────────────────────
describe('viewFiltersToQuery — emission shapes', () => {
  it('single value uses field:value', () => {
    expect(viewFiltersToQuery({ status: 'in_progress' })).toBe('status:in_progress');
    expect(viewFiltersToQuery({ status: ['in_progress'] })).toBe('status:in_progress');
  });

  it('multi value uses an IN-list', () => {
    expect(viewFiltersToQuery({ status: ['draft', 'in_progress'] })).toBe(
      'status:(draft, in_progress)',
    );
  });

  it('quotes values that need quoting inside lists', () => {
    expect(viewFiltersToQuery({ assignee: ['agent:codex', 'claude'] })).toBe(
      'assignee:("agent:codex", claude)',
    );
  });

  it('assignee __unassigned__ sentinel → assignee:none', () => {
    expect(viewFiltersToQuery({ assignee: '__unassigned__' })).toBe('assignee:none');
  });

  it('project __standalone__ sentinel → project:none', () => {
    expect(viewFiltersToQuery({ project: '__standalone__' })).toBe('project:none');
  });

  it('search is always quoted', () => {
    expect(viewFiltersToQuery({ search: 'derived status' })).toBe('search:"derived status"');
    expect(viewFiltersToQuery({ search: 'plain' })).toBe('search:"plain"');
  });

  it('activity stale/fresh → updated comparison', () => {
    expect(viewFiltersToQuery({ activity: 'stale' })).toBe('updated < -7d');
    expect(viewFiltersToQuery({ activity: 'fresh' })).toBe('updated >= -7d');
  });

  it('dateRange last_* presets → field >= -X', () => {
    expect(viewFiltersToQuery({ dateRange: { field: 'created', preset: 'last_24h' } })).toBe(
      'created >= -24h',
    );
    expect(viewFiltersToQuery({ dateRange: { field: 'created', preset: 'last_7d' } })).toBe(
      'created >= -7d',
    );
    expect(viewFiltersToQuery({ dateRange: { field: 'updated', preset: 'last_30d' } })).toBe(
      'updated >= -30d',
    );
    expect(viewFiltersToQuery({ dateRange: { field: 'created', preset: 'last_90d' } })).toBe(
      'created >= -90d',
    );
  });

  it('dateRange older_* presets → field < -X', () => {
    expect(viewFiltersToQuery({ dateRange: { field: 'created', preset: 'older_7d' } })).toBe(
      'created < -7d',
    );
    expect(viewFiltersToQuery({ dateRange: { field: 'created', preset: 'older_30d' } })).toBe(
      'created < -30d',
    );
  });

  it('dateRange absolute from/to → date comparisons', () => {
    expect(viewFiltersToQuery({ dateRange: { field: 'created', from: '2026-06-01' } })).toBe(
      'created >= 2026-06-01',
    );
    expect(viewFiltersToQuery({ dateRange: { field: 'created', to: '2026-06-30' } })).toBe(
      'created <= 2026-06-30',
    );
    expect(
      viewFiltersToQuery({ dateRange: { field: 'updated', from: '2026-06-01', to: '2026-06-30' } }),
    ).toBe('updated >= 2026-06-01 AND updated <= 2026-06-30');
  });

  it('joins multiple chip atoms with AND', () => {
    expect(
      viewFiltersToQuery({ status: 'in_progress', priority: ['high', 'critical'], search: 'foo' }),
    ).toBe('status:in_progress AND priority:(high, critical) AND search:"foo"');
  });
});

// ── queryToViewFilters: round-trippable parse ────────────────────────────────
describe('queryToViewFilters — chip-representable parse', () => {
  it('empty / match-all → {}', () => {
    expect(queryToViewFilters('')).toEqual({});
    expect(queryToViewFilters('*')).toEqual({});
  });

  it('single chip atom', () => {
    expect(queryToViewFilters('status:in_progress')).toEqual({ status: ['in_progress'] });
  });

  it('IN-list → multi-select', () => {
    expect(queryToViewFilters('status:(draft, in_progress)')).toEqual({
      status: ['draft', 'in_progress'],
    });
  });

  it('quoted value', () => {
    expect(queryToViewFilters('assignee:"agent:codex"')).toEqual({ assignee: ['agent:codex'] });
  });

  it('assignee:none → __unassigned__', () => {
    expect(queryToViewFilters('assignee:none')).toEqual({ assignee: ['__unassigned__'] });
  });

  it('project:none → __standalone__', () => {
    expect(queryToViewFilters('project:none')).toEqual({ project: ['__standalone__'] });
  });

  it('search', () => {
    expect(queryToViewFilters('search:"derived status"')).toEqual({ search: 'derived status' });
  });

  it('activity stale/fresh exact shapes', () => {
    expect(queryToViewFilters('updated < -7d')).toEqual({ activity: 'stale' });
    expect(queryToViewFilters('updated >= -7d')).toEqual({ activity: 'fresh' });
  });

  it('dateRange presets (non-colliding)', () => {
    expect(queryToViewFilters('created >= -24h')).toEqual({
      dateRange: { field: 'created', preset: 'last_24h' },
    });
    expect(queryToViewFilters('created >= -7d')).toEqual({
      dateRange: { field: 'created', preset: 'last_7d' },
    });
    expect(queryToViewFilters('updated >= -30d')).toEqual({
      dateRange: { field: 'updated', preset: 'last_30d' },
    });
    expect(queryToViewFilters('created < -30d')).toEqual({
      dateRange: { field: 'created', preset: 'older_30d' },
    });
    expect(queryToViewFilters('created < -7d')).toEqual({
      dateRange: { field: 'created', preset: 'older_7d' },
    });
  });

  it('dateRange absolute from/to', () => {
    expect(queryToViewFilters('created >= 2026-06-01')).toEqual({
      dateRange: { field: 'created', from: '2026-06-01' },
    });
    expect(queryToViewFilters('updated <= 2026-06-30')).toEqual({
      dateRange: { field: 'updated', to: '2026-06-30' },
    });
    expect(queryToViewFilters('updated >= 2026-06-01 AND updated <= 2026-06-30')).toEqual({
      dateRange: { field: 'updated', from: '2026-06-01', to: '2026-06-30' },
    });
  });

  it('flat AND of distinct chip slots', () => {
    expect(
      queryToViewFilters('status:in_progress AND priority:(high, critical) AND search:"foo"'),
    ).toEqual({
      status: ['in_progress'],
      priority: ['high', 'critical'],
      search: 'foo',
    });
  });
});

// ── queryToViewFilters: null fallbacks ───────────────────────────────────────
describe('queryToViewFilters — non-chip-representable → null', () => {
  it('OR query', () => {
    expect(queryToViewFilters('status:draft OR status:in_progress')).toBeNull();
  });
  it('NOT query', () => {
    expect(queryToViewFilters('NOT status:draft')).toBeNull();
    expect(queryToViewFilters('-status:draft')).toBeNull();
  });
  it('parenthesized grouping that introduces OR/NOT', () => {
    // A grouping that changes structure (OR/NOT/nesting) is detectable post-parse
    // and rejected. NOTE: a purely COSMETIC paren around a flat AND
    // (`(status:draft AND priority:high)`) parses to the IDENTICAL AST as the
    // unparenthesized form — the parser discards the redundant paren — so it is
    // structurally indistinguishable and correctly accepted (round-trips fine).
    expect(queryToViewFilters('status:draft AND (priority:high OR priority:low)')).toBeNull();
    expect(queryToViewFilters('(status:draft OR status:review)')).toBeNull();
    expect(queryToViewFilters('status:draft AND NOT priority:low')).toBeNull();
  });
  it('fact atom', () => {
    expect(queryToViewFilters('qaPassed:true')).toBeNull();
    expect(queryToViewFilters('planApproved:true')).toBeNull();
  });
  it('phase / disposition atoms', () => {
    expect(queryToViewFilters('phase:ready_to_implement')).toBeNull();
    expect(queryToViewFilters('disposition:blocked')).toBeNull();
  });
  it('statusAge / completedAt comparisons outside dateRange shapes', () => {
    expect(queryToViewFilters('statusAge > 3d')).toBeNull();
    expect(queryToViewFilters('completedAt >= -7d')).toBeNull();
  });
  it('updated/created comparison outside recognized shapes', () => {
    expect(queryToViewFilters('updated > -36h')).toBeNull(); // > not a recognized op
    expect(queryToViewFilters('updated < -90d')).toBeNull(); // < with non-7d magnitude
  });
  it('duplicate slot (two status atoms)', () => {
    expect(queryToViewFilters('status:draft AND status:in_progress')).toBeNull();
  });
  it('duplicate date field beyond from/to pair', () => {
    expect(queryToViewFilters('created >= 2026-06-01 AND created >= 2026-06-05')).toBeNull();
  });
  it('two distinct date fields with bounds (separate dateRange slots)', () => {
    expect(queryToViewFilters('created >= 2026-06-01 AND updated <= 2026-06-30')).toBeNull();
  });
  it('activity collides with an updated bound on the same field (both orders)', () => {
    // updated owns one slot: an activity shape + an absolute updated bound is a
    // duplicate, regardless of atom order.
    expect(queryToViewFilters('updated >= 2026-06-01 AND updated < -7d')).toBeNull();
    expect(queryToViewFilters('updated < -7d AND updated >= 2026-06-01')).toBeNull();
  });
  it('activity collides with an updated preset on the same field', () => {
    expect(queryToViewFilters('updated >= -30d AND updated < -7d')).toBeNull();
  });
  it('unknown field-shaped atom', () => {
    expect(queryToViewFilters('title:engine')).toBeNull(); // title is not a chip slot
  });
  it('invalid query string', () => {
    expect(queryToViewFilters('status:')).toBeNull();
    expect(queryToViewFilters('((')).toBeNull();
  });
});

// ── Round-trip law ───────────────────────────────────────────────────────────
// For any chip-only ViewFilters f: queryToViewFilters(viewFiltersToQuery(f))
// deep-equals normalizeChipFilters(f). Normalization: multi-capable fields →
// canonical deduped string[] (drops 'all'/empty), omitting empty; sentinels
// preserved; search trimmed and omitted when blank; activity 'all'/undefined
// omitted; a `field:'updated'` dateRange whose preset collides with an activity
// shape (older_7d/last_7d) folds into activity (stale/fresh) and the dateRange
// is dropped.
describe('round-trip law', () => {
  const cases: Array<{ name: string; f: ViewFilters }> = [
    { name: 'empty', f: {} },
    { name: 'status single', f: { status: 'in_progress' } },
    { name: 'status multi', f: { status: ['draft', 'in_progress', 'review'] } },
    { name: 'type', f: { type: ['feature', 'bug'] } },
    { name: 'priority', f: { priority: 'high' } },
    { name: 'priority multi', f: { priority: ['high', 'critical'] } },
    { name: 'assignee', f: { assignee: ['claude', 'agent:codex'] } },
    { name: 'assignee unassigned', f: { assignee: '__unassigned__' } },
    { name: 'project', f: { project: ['syntaur', 'other'] } },
    { name: 'project standalone', f: { project: '__standalone__' } },
    { name: 'tags multi', f: { tags: ['aql', 'protocol'] } },
    { name: 'search', f: { search: 'derived status' } },
    { name: 'activity stale', f: { activity: 'stale' } },
    { name: 'activity fresh', f: { activity: 'fresh' } },
    { name: 'dateRange last_24h created', f: { dateRange: { field: 'created', preset: 'last_24h' } } },
    { name: 'dateRange last_30d updated', f: { dateRange: { field: 'updated', preset: 'last_30d' } } },
    { name: 'dateRange last_90d created', f: { dateRange: { field: 'created', preset: 'last_90d' } } },
    { name: 'dateRange older_30d created', f: { dateRange: { field: 'created', preset: 'older_30d' } } },
    { name: 'dateRange older_7d created', f: { dateRange: { field: 'created', preset: 'older_7d' } } },
    { name: 'dateRange from only', f: { dateRange: { field: 'created', from: '2026-06-01' } } },
    { name: 'dateRange to only', f: { dateRange: { field: 'updated', to: '2026-06-30' } } },
    {
      name: 'dateRange from+to',
      f: { dateRange: { field: 'updated', from: '2026-06-01', to: '2026-06-30' } },
    },
    {
      name: 'combo',
      f: {
        status: ['in_progress'],
        priority: ['high', 'critical'],
        assignee: '__unassigned__',
        tags: ['aql'],
        search: 'engine',
        dateRange: { field: 'created', preset: 'last_30d' },
      },
    },
  ];

  for (const { name, f } of cases) {
    it(name, () => {
      const q = viewFiltersToQuery(f);
      const back = queryToViewFilters(q);
      expect(back).toEqual(normalizeChipFilters(f));
    });
  }

  it('collision: updated older_7d dateRange folds to activity stale', () => {
    const f: ViewFilters = { dateRange: { field: 'updated', preset: 'older_7d' } };
    expect(normalizeChipFilters(f)).toEqual({ activity: 'stale' });
    expect(queryToViewFilters(viewFiltersToQuery(f))).toEqual({ activity: 'stale' });
  });

  it('collision: updated last_7d dateRange folds to activity fresh', () => {
    const f: ViewFilters = { dateRange: { field: 'updated', preset: 'last_7d' } };
    expect(normalizeChipFilters(f)).toEqual({ activity: 'fresh' });
    expect(queryToViewFilters(viewFiltersToQuery(f))).toEqual({ activity: 'fresh' });
  });
});
