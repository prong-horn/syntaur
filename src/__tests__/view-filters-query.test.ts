import { describe, it, expect } from 'vitest';
import {
  quoteQueryValue,
  viewFiltersToQuery,
  queryToViewFilters,
  normalizeChipFilters,
} from '../utils/view-filters-query.js';
import {
  captureCurrentView,
  mergeUpdatedConfig,
  type CaptureInput,
} from '../utils/saved-view-builder.js';
import { isViewFilters, type SavedViewConfig } from '../utils/saved-views-schema.js';
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

  // ── activity + a non-7d updated dateRange parse to BOTH slots ───────────────
  // The exact 7d atom fills the activity sub-slot; the other `updated` atom fills
  // the updated dateRange sub-slot. AND is order-independent, so both atom orders
  // must produce the same ViewFilters.
  it('activity + updated relative dateRange (both orders)', () => {
    const expected = { activity: 'stale', dateRange: { field: 'updated', preset: 'last_30d' } };
    expect(queryToViewFilters('updated < -7d AND updated >= -30d')).toEqual(expected);
    expect(queryToViewFilters('updated >= -30d AND updated < -7d')).toEqual(expected);
  });

  it('activity fresh + updated older relative dateRange (both orders)', () => {
    const expected = { activity: 'fresh', dateRange: { field: 'updated', preset: 'older_30d' } };
    expect(queryToViewFilters('updated >= -7d AND updated < -30d')).toEqual(expected);
    expect(queryToViewFilters('updated < -30d AND updated >= -7d')).toEqual(expected);
  });

  it('activity + updated absolute bound dateRange (both orders)', () => {
    const expected = { activity: 'stale', dateRange: { field: 'updated', from: '2026-06-01' } };
    expect(queryToViewFilters('updated < -7d AND updated >= 2026-06-01')).toEqual(expected);
    expect(queryToViewFilters('updated >= 2026-06-01 AND updated < -7d')).toEqual(expected);
  });

  it('activity + updated absolute from+to dateRange', () => {
    expect(
      queryToViewFilters('updated < -7d AND updated >= 2026-06-01 AND updated <= 2026-06-30'),
    ).toEqual({
      activity: 'stale',
      dateRange: { field: 'updated', from: '2026-06-01', to: '2026-06-30' },
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
    // A preset on one field colliding with a bound on ANOTHER field still →
    // null (only one dateRange slot exists; exercises the post-loop guard).
    expect(queryToViewFilters('created >= -30d AND updated >= 2026-06-01')).toBeNull();
  });
  it('two genuine updated dateRange lower bounds (both relative, neither the 7d activity shape) → null', () => {
    // Two `>=` relative `updated` atoms both want the dateRange lower-bound
    // sub-slot (a preset whole-range slot) — a real duplicate, still null.
    expect(queryToViewFilters('updated >= -30d AND updated >= -90d')).toBeNull();
    // Two activity-shaped atoms both want the activity sub-slot → still null.
    expect(queryToViewFilters('updated < -7d AND updated < -7d')).toBeNull();
    expect(queryToViewFilters('updated >= -7d AND updated >= -7d')).toBeNull();
    // A preset and an absolute bound on the SAME field still conflict.
    expect(queryToViewFilters('updated >= -30d AND updated >= 2026-06-01')).toBeNull();
    // Two absolute lower bounds on updated still conflict.
    expect(queryToViewFilters('updated >= 2026-06-01 AND updated >= 2026-06-05')).toBeNull();
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
    // ── activity × updated-dateRange (the fixed round-trip class) ──────────────
    // The exact 7d shape is activity; ANY other `updated` atom is the dateRange,
    // so these coexist and round-trip losslessly.
    {
      name: 'activity stale + updated last_30d',
      f: { activity: 'stale', dateRange: { field: 'updated', preset: 'last_30d' } },
    },
    {
      name: 'activity fresh + updated last_30d',
      f: { activity: 'fresh', dateRange: { field: 'updated', preset: 'last_30d' } },
    },
    {
      name: 'activity stale + updated older_30d',
      f: { activity: 'stale', dateRange: { field: 'updated', preset: 'older_30d' } },
    },
    {
      name: 'activity fresh + updated last_90d',
      f: { activity: 'fresh', dateRange: { field: 'updated', preset: 'last_90d' } },
    },
    {
      name: 'activity stale + updated from only (absolute)',
      f: { activity: 'stale', dateRange: { field: 'updated', from: '2026-06-01' } },
    },
    {
      name: 'activity fresh + updated to only (absolute)',
      f: { activity: 'fresh', dateRange: { field: 'updated', to: '2026-06-30' } },
    },
    {
      name: 'activity stale + updated from+to (absolute)',
      f: {
        activity: 'stale',
        dateRange: { field: 'updated', from: '2026-06-01', to: '2026-06-30' },
      },
    },
    {
      name: 'activity + updated dateRange + value slot all together',
      f: {
        status: ['in_progress'],
        activity: 'stale',
        dateRange: { field: 'updated', preset: 'last_30d' },
      },
    },
    {
      // Cross-field: activity lives on the `updated` 7d sub-slot, the dateRange
      // on `created` — fully independent slots, the canonical "both at once".
      name: 'activity stale + created dateRange',
      f: { activity: 'stale', dateRange: { field: 'created', preset: 'last_30d' } },
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

// ── AC4: lossless upgrade of a query-less view ───────────────────────────────
// A saved view persisted before AQL carries chip filters but NO `query` key. The
// upgrade path synthesizes a query from those filters; re-parsing that query must
// reproduce the original (normalized) chip filters — no data lost in the bridge.
describe('AC4 — lossless chip→query→chip upgrade for query-less views', () => {
  const legacyFilters: Array<{ name: string; f: ViewFilters }> = [
    { name: 'status + priority + search', f: { status: ['in_progress'], priority: ['high', 'critical'], search: 'engine' } },
    { name: 'unassigned + project standalone', f: { assignee: '__unassigned__', project: '__standalone__' } },
    { name: 'tags + activity + dateRange', f: { tags: ['aql', 'protocol'], activity: 'stale', dateRange: { field: 'created', preset: 'last_30d' } } },
    { name: 'actor assignee needing quotes', f: { assignee: ['agent:codex', 'claude'] } },
  ];
  for (const { name, f } of legacyFilters) {
    it(`${name} survives the synthesize→reparse round-trip`, () => {
      const synthesized = viewFiltersToQuery(f); // what the upgrade writes into `query`
      expect(synthesized.length).toBeGreaterThan(0);
      expect(queryToViewFilters(synthesized)).toEqual(normalizeChipFilters(f));
    });
  }
});

// ── AC4: the `query` filter key survives minimize / merge ────────────────────
// `captureCurrentView` runs the (private) `minimizeFilters`; the CLI add/update
// paths and every dashboard save funnel through it. Confirm the query string is
// preserved, trimmed, and dropped when blank — and that mergeUpdatedConfig
// rebuilds it from the freshly-built config (it is a KNOWN filter key).
describe('AC4 — query key through minimizeFilters / mergeUpdatedConfig', () => {
  function capture(filters: ViewFilters): ViewFilters {
    const input: CaptureInput = {
      name: 'X',
      context: { workspace: null, projectSlug: null },
      state: {
        viewMode: 'kanban',
        filters,
        sortField: 'updated',
        sortDirection: 'desc',
        listSectionVisibility: { collapsed: [] },
        kanbanColumnVisibility: { hidden: [] },
        tableColumnVisibility: { hidden: [] },
      },
    };
    return captureCurrentView(input).config.filters;
  }

  it('preserves a non-empty query verbatim', () => {
    expect(capture({ query: 'qaPassed:true AND priority:high' }).query).toBe(
      'qaPassed:true AND priority:high',
    );
  });

  it('trims surrounding whitespace on the query', () => {
    expect(capture({ query: '  status:in_progress  ' }).query).toBe('status:in_progress');
  });

  it('drops a blank / whitespace-only query', () => {
    expect(capture({ query: '' }).query).toBeUndefined();
    expect(capture({ query: '   ' }).query).toBeUndefined();
  });

  it('mergeUpdatedConfig carries the freshly-built query (known filter key)', () => {
    const base: SavedViewConfig = {
      viewMode: 'kanban',
      filters: { query: 'status:draft' },
      sortField: 'updated',
      sortDirection: 'desc',
      listSectionVisibility: { collapsed: [] },
      kanbanColumnVisibility: { hidden: [] },
      tableColumnVisibility: { hidden: [] },
    };
    const built: SavedViewConfig = { ...base, filters: { query: 'qaPassed:true' } };
    const merged = mergeUpdatedConfig(base, built, {
      listSectionVisibility: { collapsed: [] },
      kanbanColumnVisibility: { hidden: [] },
      tableColumnVisibility: { hidden: [] },
    });
    expect(merged.filters.query).toBe('qaPassed:true');

    // Built config with NO query drops it (rebuilt from `built`, not retained).
    const cleared = mergeUpdatedConfig(base, { ...base, filters: {} }, {
      listSectionVisibility: { collapsed: [] },
      kanbanColumnVisibility: { hidden: [] },
      tableColumnVisibility: { hidden: [] },
    });
    expect(cleared.filters.query).toBeUndefined();
  });
});

// ── AC4: isViewFilters accepts string query, rejects non-string ──────────────
describe('AC4 — isViewFilters query typing', () => {
  it('accepts a string query', () => {
    expect(isViewFilters({ query: 'status:in_progress' })).toBe(true);
    expect(isViewFilters({ query: '' })).toBe(true); // empty string still a string
  });
  it('rejects a non-string query', () => {
    expect(isViewFilters({ query: 123 })).toBe(false);
    expect(isViewFilters({ query: ['status:draft'] })).toBe(false);
    expect(isViewFilters({ query: { raw: 'x' } })).toBe(false);
    expect(isViewFilters({ query: null })).toBe(false);
  });
});

// ── AC7: custom status ids are an OPEN enum in the translator ─────────────────
// The translator must not assume the default status vocabulary — an arbitrary
// custom status id round-trips through both directions like any other value.
describe('AC7 — translator treats status as an open enum (custom ids)', () => {
  it('single arbitrary custom status id round-trips', () => {
    expect(viewFiltersToQuery({ status: 'awaiting_triage' })).toBe('status:awaiting_triage');
    expect(queryToViewFilters('status:awaiting_triage')).toEqual({ status: ['awaiting_triage'] });
  });

  it('multi custom status ids round-trip as an IN-list', () => {
    const f: ViewFilters = { status: ['awaiting_triage', 'shipped_to_staging'] };
    const q = viewFiltersToQuery(f);
    expect(q).toBe('status:(awaiting_triage, shipped_to_staging)');
    expect(queryToViewFilters(q)).toEqual(normalizeChipFilters(f));
  });

  it('a custom status id needing quotes (leading digit / colon) round-trips', () => {
    const f: ViewFilters = { status: ['phase:2', 'foo'] };
    const q = viewFiltersToQuery(f);
    expect(q).toBe('status:("phase:2", foo)');
    expect(queryToViewFilters(q)).toEqual(normalizeChipFilters(f));
  });
});
