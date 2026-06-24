import { describe, it, expect } from 'vitest';
import { compileQuery, parseQuery, validateQuery, type QueryItem } from '../utils/query/index.js';

const NOW = Date.parse('2026-06-09T12:00:00Z');
const CTX = { now: NOW };

function matches(query: string, item: QueryItem): boolean {
  const { query: compiled, errors } = compileQuery(query);
  if (!compiled) throw new Error(`compile failed: ${errors.map((e) => e.message).join('; ')}`);
  return compiled.predicate(item, CTX);
}

const ITEM: QueryItem = {
  status: 'in_progress',
  phase: 'ready_to_implement',
  disposition: 'blocked',
  priority: 'high',
  type: 'feature',
  assignee: 'claude',
  project: 'syntaur-meta',
  tags: ['aql', 'protocol'],
  archived: false,
  title: 'Derived Status Engine',
  created: '2026-06-01T10:00:00Z',
  updated: '2026-06-09T09:00:00Z',
  completedAt: null,
  statusAge: 4 * 86_400_000, // 4d
  hasRealObjective: true,
  acRealTotal: 5,
  acRealChecked: 2,
  acAllChecked: false,
  planExists: true,
  planApproved: true,
  workspaceSet: true,
  implementationStarted: false,
  blocked: true,
  parked: false,
  reviewRequested: false,
  reworkRequested: false,
  unresolvedQuestions: 1,
};

describe('AQL atoms', () => {
  it('field:value equality (case-insensitive)', () => {
    expect(matches('status:in_progress', ITEM)).toBe(true);
    expect(matches('STATUS:IN_PROGRESS', ITEM)).toBe(true);
    expect(matches('status:draft', ITEM)).toBe(false);
  });

  it('IN list field:(a, b)', () => {
    expect(matches('status:(draft, in_progress)', ITEM)).toBe(true);
    expect(matches('status:(draft, review)', ITEM)).toBe(false);
  });

  it('negation -field:value and NOT', () => {
    expect(matches('-status:draft', ITEM)).toBe(true);
    expect(matches('NOT status:in_progress', ITEM)).toBe(false);
  });

  it('bool fields', () => {
    expect(matches('planApproved:true', ITEM)).toBe(true);
    expect(matches('acAllChecked:false', ITEM)).toBe(true);
    expect(matches('blocked:false', ITEM)).toBe(false);
  });

  it('none sentinel', () => {
    expect(matches('assignee:none', ITEM)).toBe(false);
    expect(matches('assignee:none', { ...ITEM, assignee: null })).toBe(true);
    expect(matches('project:none', { ...ITEM, project: null })).toBe(true);
  });

  it('list membership (tag/tags)', () => {
    expect(matches('tag:aql', ITEM)).toBe(true);
    expect(matches('tags:protocol', ITEM)).toBe(true);
    expect(matches('tag:missing', ITEM)).toBe(false);
  });

  it('substring (title/search)', () => {
    expect(matches('title:engine', ITEM)).toBe(true);
    expect(matches('search:"derived status"', ITEM)).toBe(true);
    expect(matches('title:zebra', ITEM)).toBe(false);
  });

  it('numeric comparisons', () => {
    expect(matches('acRealTotal > 0', ITEM)).toBe(true);
    expect(matches('acRealChecked >= 5', ITEM)).toBe(false);
    expect(matches('unresolvedQuestions = 1', ITEM)).toBe(true);
  });

  it('ordinal priority', () => {
    expect(matches('priority >= high', ITEM)).toBe(true);
    expect(matches('priority > high', ITEM)).toBe(false);
    expect(matches('priority < critical', ITEM)).toBe(true);
    expect(matches('priority:high', ITEM)).toBe(true);
  });
});

describe('AQL booleans + precedence', () => {
  it('AND / OR / NOT with parens', () => {
    expect(matches('planApproved:true AND blocked:true', ITEM)).toBe(true);
    expect(matches('status:draft OR blocked:true', ITEM)).toBe(true);
    expect(matches('NOT (status:draft OR parked:true)', ITEM)).toBe(true);
  });

  it('implicit AND between adjacent atoms', () => {
    expect(matches('planApproved:true blocked:true', ITEM)).toBe(true);
    expect(matches('planApproved:true parked:true', ITEM)).toBe(false);
  });

  it('precedence NOT > AND > OR', () => {
    // a OR b AND c  ==  a OR (b AND c)
    expect(matches('status:draft OR planApproved:true AND blocked:true', ITEM)).toBe(true);
    // NOT a AND b  ==  (NOT a) AND b
    expect(matches('NOT parked:true AND blocked:true', ITEM)).toBe(true);
  });

  it('match-all star and empty query', () => {
    expect(matches('*', ITEM)).toBe(true);
    expect(matches('', ITEM)).toBe(true);
  });

  it('the design doc flagship query', () => {
    expect(matches('disposition:blocked AND phase:ready_to_implement', ITEM)).toBe(true);
    expect(matches('planApproved:true AND workspaceSet:false', ITEM)).toBe(false);
  });
});

describe('AQL time semantics', () => {
  it('duration literal vs timestamp = relative point (bare means ago)', () => {
    // created 2026-06-01, now 2026-06-09 → 8 days ago
    expect(matches('created > -36h', ITEM)).toBe(false); // not within last 36h
    expect(matches('updated > -36h', ITEM)).toBe(true); // 3h ago
    expect(matches('created > 10d', ITEM)).toBe(true); // bare = ago: after (now-10d)
  });

  it('duration literal vs duration field = magnitude', () => {
    expect(matches('statusAge > 3d', ITEM)).toBe(true);
    expect(matches('statusAge < 3d', ITEM)).toBe(false);
    expect(matches('statusAge <= 4d', ITEM)).toBe(true);
  });

  it('absolute dates compare on local-day boundaries', () => {
    const item = { ...ITEM, created: new Date(2026, 5, 5, 15, 30).toISOString() }; // June 5 local
    expect(matches('created:2026-06-05', item)).toBe(true);
    expect(matches('created > 2026-06-04', item)).toBe(true);
    expect(matches('created > 2026-06-05', item)).toBe(false); // > means after that day
    expect(matches('created <= 2026-06-05', item)).toBe(true);
    expect(matches('created != 2026-06-05', item)).toBe(false);
  });

  it('null timestamps fail comparisons', () => {
    expect(matches('completedAt < -1m', ITEM)).toBe(false);
  });

  // AC8: impossible calendar dates must compile to an error, not silently roll
  // over (2026-02-30 → Mar 2) and filter the wrong day.
  it('rejects impossible calendar dates instead of rolling over', () => {
    for (const q of ['created:2026-02-30', 'created:2026-13-45', 'created > 2026-00-10']) {
      const { query: compiled, errors } = compileQuery(q);
      expect(compiled).toBeNull();
      expect(errors.some((e) => /invalid date/i.test(e.message))).toBe(true);
    }
    // A valid date still compiles + filters.
    const item = { ...ITEM, created: new Date(2026, 5, 16, 9, 0).toISOString() };
    expect(matches('created:2026-06-16', item)).toBe(true);
  });

  // AC8: a trailing digit must not be swallowed into a date token.
  it('does not lex a trailing-digit run as a date', () => {
    // `2026-06-1623` should NOT become DATE(2026-06-16)+NUMBER(23); it must not
    // silently match June 16.
    const item = { ...ITEM, created: new Date(2026, 5, 16, 9, 0).toISOString() };
    expect(matches('created:2026-06-16', item)).toBe(true); // sanity
    const { query: compiled } = compileQuery('created:2026-06-1623');
    // Either a compile error or a non-matching predicate — but never a silent June-16 match.
    if (compiled) expect(compiled.predicate(item, CTX)).toBe(false);
  });

  it('month/year unit aliases', () => {
    expect(matches('created > -1mo', ITEM)).toBe(true);
    expect(matches('created > -1y', ITEM)).toBe(true);
  });
});

// ── AC8: the exact relative-date shapes the dashboard feature relies on ───────
// completedAt < -1mo (non-null), >= -7d / < -7d (the activity boundary), and the
// > -36h shape — all resolved against a FIXED injected now (never wall-clock).
describe('AC8 — relative-date ops the saved-view/dashboard layer uses', () => {
  it('completedAt < -1mo matches a terminal item completed long ago, misses a recent one', () => {
    const old = { ...ITEM, status: 'completed', completedAt: '2026-04-01T10:00:00Z' };
    const recent = { ...ITEM, status: 'completed', completedAt: '2026-06-08T10:00:00Z' };
    expect(matches('completedAt < -1mo', old)).toBe(true); // > 1 month before now
    expect(matches('completedAt < -1mo', recent)).toBe(false); // within the month
    expect(matches('completedAt < -1mo', ITEM)).toBe(false); // null never matches
  });

  it('updated >= -7d / < -7d split items on the 7-day activity boundary', () => {
    // now = 2026-06-09T12:00:00Z → 7 days ago = 2026-06-02T12:00:00Z.
    const fresh = { ...ITEM, updated: '2026-06-09T09:00:00Z' }; // 3h ago
    const stale = { ...ITEM, updated: '2026-05-20T10:00:00Z' }; // ~20d ago
    expect(matches('updated >= -7d', fresh)).toBe(true);
    expect(matches('updated >= -7d', stale)).toBe(false);
    expect(matches('updated < -7d', stale)).toBe(true);
    expect(matches('updated < -7d', fresh)).toBe(false);
  });

  it('created > -36h OR updated > -36h evaluates each field independently', () => {
    const justCreated = { ...ITEM, created: '2026-06-09T06:00:00Z', updated: '2026-05-01T10:00:00Z' };
    const justUpdated = { ...ITEM, created: '2026-05-01T10:00:00Z', updated: '2026-06-09T09:00:00Z' };
    const cold = { ...ITEM, created: '2026-05-01T10:00:00Z', updated: '2026-05-02T10:00:00Z' };
    expect(matches('created > -36h OR updated > -36h', justCreated)).toBe(true);
    expect(matches('created > -36h OR updated > -36h', justUpdated)).toBe(true);
    expect(matches('created > -36h OR updated > -36h', cold)).toBe(false);
  });

  it('statusAge >= 7d compares the duration magnitude', () => {
    expect(matches('statusAge >= 7d', { ...ITEM, statusAge: 8 * 86_400_000 })).toBe(true);
    expect(matches('statusAge >= 7d', { ...ITEM, statusAge: 3 * 86_400_000 })).toBe(false);
  });
});

describe('AQL structured errors', () => {
  it('unknown field with position', () => {
    const errors = validateQuery('bogusfield:true');
    expect(errors).toHaveLength(1);
    expect(errors[0].pos).toBe(0);
    expect(errors[0].message).toContain('Unknown field');
  });

  it('unbalanced parens', () => {
    const errors = validateQuery('(status:draft OR blocked:true');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('bad duration unit', () => {
    const errors = validateQuery('statusAge > 3q');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('duration unit');
  });

  it('boolean misuse guidance', () => {
    const errors = validateQuery('blocked:yes');
    expect(errors[0].message).toContain('boolean');
  });

  it('duration field without comparison', () => {
    const errors = validateQuery('statusAge:3d');
    expect(errors[0].message).toContain('comparison');
  });

  it('valid derive-rule conditions all validate', () => {
    for (const q of [
      '*',
      'hasRealObjective:true AND acRealTotal > 0',
      'planExists:true',
      'planApproved:true',
      'planApproved:true AND implementationStarted:true',
      'acAllChecked:true OR reviewRequested:true',
      'parked:true',
      'blocked:true',
    ]) {
      expect(validateQuery(q)).toEqual([]);
    }
  });
});

describe('AQL parser AST shape', () => {
  it('parses without throwing and reports no errors on valid input', () => {
    const r = parseQuery('a:1 OR (b:2 AND NOT c:3)');
    // unknown fields are a COMPILE error, not a parse error
    expect(r.ast).not.toBeNull();
  });
});
