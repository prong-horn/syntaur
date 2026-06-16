import { describe, it, expect } from 'vitest';
import { compileQuery, type QueryItem } from '@shared/query';
import { splitPaletteQuery, PALETTE_FIELDS } from '../paletteQuery';

const split = (q: string) => splitPaletteQuery(q);

describe('splitPaletteQuery — alias expansion', () => {
  it('bare alias → kind atom, no fuzzy', () => {
    expect(split('a:')).toEqual({ aqlExpr: 'kind:assignment', fuzzy: '' });
    expect(split('p:')).toEqual({ aqlExpr: 'kind:project', fuzzy: '' });
    expect(split('t:')).toEqual({ aqlExpr: 'kind:todo', fuzzy: '' });
    expect(split('s:')).toEqual({ aqlExpr: 'kind:server', fuzzy: '' });
    expect(split('pb:')).toEqual({ aqlExpr: 'kind:playbook', fuzzy: '' });
  });

  it('glued alias value → kind atom + free text', () => {
    expect(split('a:payment')).toEqual({ aqlExpr: 'kind:assignment', fuzzy: 'payment' });
  });

  it('alias + atom + free text', () => {
    expect(split('a: jira:ABC payment')).toEqual({
      aqlExpr: 'kind:assignment jira:ABC',
      fuzzy: 'payment',
    });
  });
});

describe('splitPaletteQuery — atom vs free text', () => {
  it('registry field → atom', () => {
    expect(split('status:done')).toEqual({ aqlExpr: 'status:done', fuzzy: '' });
  });

  it('bare word → fuzzy', () => {
    expect(split('payment')).toEqual({ aqlExpr: '', fuzzy: 'payment' });
  });

  it('unknown field stays literal free text', () => {
    expect(split('foo:bar')).toEqual({ aqlExpr: '', fuzzy: 'foo:bar' });
  });

  it('trailing in-progress atom degrades to free text', () => {
    expect(split('status:')).toEqual({ aqlExpr: '', fuzzy: 'status:' });
  });

  it('negation is an atom', () => {
    expect(split('-status:done')).toEqual({ aqlExpr: '-status:done', fuzzy: '' });
    expect(split('NOT status:done')).toEqual({ aqlExpr: 'NOT status:done', fuzzy: '' });
  });

  it('IN-list is an atom, not explicit-boolean', () => {
    expect(split('status:(done, blocked)')).toEqual({
      aqlExpr: 'status:(done, blocked)',
      fuzzy: '',
    });
  });

  it('IN-list + free text', () => {
    expect(split('status:(done, blocked) payment')).toEqual({
      aqlExpr: 'status:(done, blocked)',
      fuzzy: 'payment',
    });
  });

  it('quoted value with hyphen/digit is a single atom', () => {
    expect(split('jira:"123-ABC"')).toEqual({ aqlExpr: 'jira:"123-ABC"', fuzzy: '' });
  });
});

describe('splitPaletteQuery — explicit boolean boundary', () => {
  it('OR routes the whole input to AQL', () => {
    expect(split('status:done OR status:blocked')).toEqual({
      aqlExpr: 'status:done OR status:blocked',
      fuzzy: '',
    });
  });

  it('grouping paren routes the whole input to AQL', () => {
    expect(split('(status:done)')).toEqual({ aqlExpr: '(status:done)', fuzzy: '' });
  });

  it('AND is NOT a trigger — natural text stays fuzzy', () => {
    expect(split('research and planning')).toEqual({
      aqlExpr: '',
      fuzzy: 'research and planning',
    });
  });
});

describe('splitPaletteQuery — robustness', () => {
  it('unlexable input is wholly free text (never throws)', () => {
    expect(split('api.ts')).toEqual({ aqlExpr: '', fuzzy: 'api.ts' });
    expect(split('claude/code')).toEqual({ aqlExpr: '', fuzzy: 'claude/code' });
    expect(split('user@example')).toEqual({ aqlExpr: '', fuzzy: 'user@example' });
  });

  it('preserves quoted/punctuated free-text spans', () => {
    expect(split('"foo bar" baz')).toEqual({ aqlExpr: '', fuzzy: '"foo bar" baz' });
  });

  it('never emits an aqlExpr that fails compileQuery', () => {
    const queries = [
      'a:',
      'a:payment',
      'status:done',
      'a: jira:ABC payment',
      'status:(done, blocked)',
      '-status:done',
      'NOT status:done',
      'jira:"123-ABC"',
      'status:done OR status:blocked',
      '-a:',
      'NOT a:',
      'a: OR p:',
      '(a:)',
      'status:()',
      'status:(done blocked)',
      'status>done',
      'payment   flow',
      'foo:bar',
    ];
    for (const q of queries) {
      const { aqlExpr } = split(q);
      if (aqlExpr) {
        expect(compileQuery(aqlExpr, PALETTE_FIELDS).query).not.toBeNull();
      }
    }
  });
});

describe('splitPaletteQuery — malformed atoms degrade to free text (aqlExpr always compiles)', () => {
  it('empty IN-list → free text', () => {
    expect(split('status:()')).toEqual({ aqlExpr: '', fuzzy: 'status:()' });
  });

  it('missing-comma IN-list → free text', () => {
    expect(split('status:(done blocked)')).toEqual({ aqlExpr: '', fuzzy: 'status:(done blocked)' });
  });

  it('unsupported comparison on an enum field → free text', () => {
    expect(split('status>done')).toEqual({ aqlExpr: '', fuzzy: 'status>done' });
  });

  it('a good atom survives a sibling malformed atom', () => {
    expect(split('a: status:()')).toEqual({ aqlExpr: 'kind:assignment', fuzzy: 'status:()' });
  });
});

describe('splitPaletteQuery — whitespace + negated aliases', () => {
  it('collapses multiple spaces in free text', () => {
    expect(split('payment   flow')).toEqual({ aqlExpr: '', fuzzy: 'payment flow' });
  });

  it('-a: → -kind:assignment', () => {
    expect(split('-a:')).toEqual({ aqlExpr: '-kind:assignment', fuzzy: '' });
  });

  it('NOT a: → NOT kind:assignment', () => {
    expect(split('NOT a:')).toEqual({ aqlExpr: 'NOT kind:assignment', fuzzy: '' });
  });
});

describe('splitPaletteQuery — alias expansion in explicit-boolean mode', () => {
  it('a: OR p: → kind:assignment OR kind:project', () => {
    expect(split('a: OR p:')).toEqual({ aqlExpr: 'kind:assignment OR kind:project', fuzzy: '' });
  });

  it('(a:) gates as kind:assignment (compiles + filters)', () => {
    const { aqlExpr, fuzzy } = split('(a:)');
    expect(fuzzy).toBe('');
    const r = compileQuery(aqlExpr, PALETTE_FIELDS);
    expect(r.query).not.toBeNull();
    expect(r.query!.predicate({ type: 'assignment' }, { now: 0 })).toBe(true);
    expect(r.query!.predicate({ type: 'project' }, { now: 0 })).toBe(false);
  });
});

describe('PALETTE_FIELDS semantics', () => {
  const matches = (expr: string, item: QueryItem): boolean => {
    const r = compileQuery(expr, PALETTE_FIELDS);
    if (!r.query) throw new Error(`compile failed: ${JSON.stringify(r.errors)}`);
    return r.query.predicate(item, { now: 0 });
  };

  it('kind enum reads entry.type', () => {
    expect(matches('kind:assignment', { type: 'assignment' })).toBe(true);
    expect(matches('kind:assignment', { type: 'project' })).toBe(false);
  });

  it('status enum equality; missing field → false', () => {
    expect(matches('status:done', { status: 'done' })).toBe(true);
    expect(matches('status:done', {})).toBe(false);
  });

  it('tag list membership', () => {
    expect(matches('tag:backend', { tags: ['backend', 'api'] })).toBe(true);
    expect(matches('tag:frontend', { tags: ['backend'] })).toBe(false);
  });

  it('type reads assignmentType, distinct from the entity kind', () => {
    const item = { type: 'assignment', assignmentType: 'feature' };
    expect(matches('type:feature', item)).toBe(true);
    // Would be true if `type` wrongly read entry.type === 'assignment'.
    expect(matches('type:assignment', item)).toBe(false);
  });

  it('assignee/project noneSentinel matches null but NOT entities lacking the field', () => {
    expect(matches('assignee:none', { assignee: null })).toBe(true);
    expect(matches('assignee:none', { assignee: 'claude' })).toBe(false);
    // A page/server entry has no `assignee` key at all → must NOT match `:none`
    // (otherwise every page/server/playbook would leak into `assignee:none`).
    expect(matches('assignee:none', { type: 'page' })).toBe(false);
    expect(matches('project:none', { project: null })).toBe(true); // standalone assignment
    expect(matches('project:none', { type: 'server' })).toBe(false); // no project key
  });

  it('jira substring with case-insensitive system selection', () => {
    const item = { externalIds: [{ system: 'JIRA', id: 'PROJ-123', url: null }] };
    expect(matches('jira:PROJ-123', item)).toBe(true);
    expect(matches('jira:proj', item)).toBe(true); // substring + case-insensitive
    expect(matches('jira:NOPE', item)).toBe(false);
  });

  it('externalid flattened "system:id" haystack', () => {
    const item = { externalIds: [{ system: 'github', id: 'gh-42', url: null }] };
    expect(matches('externalid:gh-42', item)).toBe(true);
    expect(matches('externalid:nope', item)).toBe(false);
  });

  it('negation of a missing field includes field-less entities (AQL parity)', () => {
    // -status:done on a page (no status) → NOT(false) → true. Documented behavior.
    expect(matches('-status:done', { type: 'page' })).toBe(true);
    expect(matches('-status:done', { type: 'assignment', status: 'done' })).toBe(false);
  });
});

describe('splitPaletteQuery — config-driven aliases', () => {
  const aliases = { x: 'assignment', proj: 'project' } as const;

  it('uses a custom alias map', () => {
    expect(splitPaletteQuery('x:', aliases)).toEqual({ aqlExpr: 'kind:assignment', fuzzy: '' });
    expect(splitPaletteQuery('proj:', aliases)).toEqual({ aqlExpr: 'kind:project', fuzzy: '' });
  });

  it('built-in aliases no longer apply when a custom map is supplied', () => {
    // 'a' is not in the custom map → stays free text, not kind:assignment.
    expect(splitPaletteQuery('a:', aliases)).toEqual({ aqlExpr: '', fuzzy: 'a:' });
  });
});

describe('splitPaletteQuery — default-scope injection', () => {
  const scope = (q: string, defaultScope: 'all' | 'project' | 'todo') =>
    splitPaletteQuery(q, undefined, { defaultScope });

  it('injects kind:<scope> when the box has no explicit prefix', () => {
    expect(scope('payment', 'project')).toEqual({ aqlExpr: 'kind:project', fuzzy: 'payment' });
    expect(scope('status:open', 'project')).toEqual({
      aqlExpr: 'kind:project status:open',
      fuzzy: '',
    });
  });

  it('an explicit prefix overrides the default scope (no double-gate)', () => {
    expect(scope('a: payment', 'project')).toEqual({
      aqlExpr: 'kind:assignment',
      fuzzy: 'payment',
    });
    expect(scope('kind:server', 'project')).toEqual({ aqlExpr: 'kind:server', fuzzy: '' });
  });

  it('the empty box and whitespace-only box search everything', () => {
    expect(scope('', 'project')).toEqual({ aqlExpr: '', fuzzy: '' });
    expect(scope('   ', 'project')).toEqual({ aqlExpr: '', fuzzy: '' });
  });

  it('a leading all: escape searches everything regardless of scope', () => {
    expect(scope('all: payment', 'project')).toEqual({ aqlExpr: '', fuzzy: 'payment' });
    expect(scope('all:', 'todo')).toEqual({ aqlExpr: '', fuzzy: '' });
  });

  it('defaultScope=all never injects', () => {
    expect(scope('payment', 'all')).toEqual({ aqlExpr: '', fuzzy: 'payment' });
  });

  it('the injected gate compiles and filters by kind', () => {
    const { aqlExpr } = scope('status:open', 'project');
    const r = compileQuery(aqlExpr, PALETTE_FIELDS);
    expect(r.query).not.toBeNull();
    expect(r.query!.predicate({ type: 'project', status: 'open' }, { now: 0 })).toBe(true);
    expect(r.query!.predicate({ type: 'assignment', status: 'open' }, { now: 0 })).toBe(false);
  });

  it('an explicit-boolean base is parenthesized so scope ANDs correctly', () => {
    const { aqlExpr } = splitPaletteQuery('status:open OR status:done', undefined, {
      defaultScope: 'project',
    });
    expect(aqlExpr).toBe('kind:project (status:open OR status:done)');
    const r = compileQuery(aqlExpr, PALETTE_FIELDS);
    expect(r.query).not.toBeNull();
    expect(r.query!.predicate({ type: 'project', status: 'done' }, { now: 0 })).toBe(true);
    expect(r.query!.predicate({ type: 'assignment', status: 'done' }, { now: 0 })).toBe(false);
  });
});
