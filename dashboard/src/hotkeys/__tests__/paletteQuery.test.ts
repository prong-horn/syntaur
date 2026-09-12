import { describe, it, expect } from 'vitest';
import { compileQuery, type QueryItem } from '@shared/query';
import { splitPaletteQuery, PALETTE_FIELDS } from '../paletteQuery';

const split = (q: string) => splitPaletteQuery(q);

describe('splitPaletteQuery — alias expansion', () => {
  it('bare alias → kind atom, no fuzzy', () => {
    expect(split('t:')).toEqual({ aqlExpr: 'kind:ticket', fuzzy: '' });
    expect(split('p:')).toEqual({ aqlExpr: 'kind:project', fuzzy: '' });
    expect(split('pb:')).toEqual({ aqlExpr: 'kind:playbook', fuzzy: '' });
  });

  it('glued alias value → kind atom + free text', () => {
    expect(split('t:payment')).toEqual({ aqlExpr: 'kind:ticket', fuzzy: 'payment' });
  });

  it('alias + atom + free text', () => {
    expect(split('t: jirt:ABC payment')).toEqual({
      aqlExpr: 'kind:ticket jirt:ABC',
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
    expect(split('jirt:"123-ABC"')).toEqual({ aqlExpr: 'jirt:"123-ABC"', fuzzy: '' });
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
      't:',
      't:payment',
      'status:done',
      't: jirt:ABC payment',
      'status:(done, blocked)',
      '-status:done',
      'NOT status:done',
      'jirt:"123-ABC"',
      'status:done OR status:blocked',
      '-t:',
      'NOT t:',
      't: OR p:',
      '(t:)',
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
    expect(split('t: status:()')).toEqual({ aqlExpr: 'kind:ticket', fuzzy: 'status:()' });
  });
});

describe('splitPaletteQuery — whitespace + negated aliases', () => {
  it('collapses multiple spaces in free text', () => {
    expect(split('payment   flow')).toEqual({ aqlExpr: '', fuzzy: 'payment flow' });
  });

  it('-t: → -kind:ticket', () => {
    expect(split('-t:')).toEqual({ aqlExpr: '-kind:ticket', fuzzy: '' });
  });

  it('NOT t: → NOT kind:ticket', () => {
    expect(split('NOT t:')).toEqual({ aqlExpr: 'NOT kind:ticket', fuzzy: '' });
  });
});

describe('splitPaletteQuery — alias expansion in explicit-boolean mode', () => {
  it('t: OR p: → kind:ticket OR kind:project', () => {
    expect(split('t: OR p:')).toEqual({ aqlExpr: 'kind:ticket OR kind:project', fuzzy: '' });
  });

  it('(t:) gates as kind:ticket (compiles + filters)', () => {
    const { aqlExpr, fuzzy } = split('(t:)');
    expect(fuzzy).toBe('');
    const r = compileQuery(aqlExpr, PALETTE_FIELDS);
    expect(r.query).not.toBeNull();
    expect(r.query!.predicate({ type: 'ticket' }, { now: 0 })).toBe(true);
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
    expect(matches('kind:ticket', { type: 'ticket' })).toBe(true);
    expect(matches('kind:ticket', { type: 'project' })).toBe(false);
  });

  it('status enum equality; missing field → false', () => {
    expect(matches('status:done', { status: 'done' })).toBe(true);
    expect(matches('status:done', {})).toBe(false);
  });

  it('tag list membership', () => {
    expect(matches('tag:backend', { tags: ['backend', 'api'] })).toBe(true);
    expect(matches('tag:frontend', { tags: ['backend'] })).toBe(false);
  });

  it('type reads ticketType, distinct from the entity kind', () => {
    const item = { type: 'ticket', ticketType: 'feature' };
    expect(matches('type:feature', item)).toBe(true);
    // Would be true if `type` wrongly read entry.type === 'ticket'.
    expect(matches('type:ticket', item)).toBe(false);
  });

  it('assignee/project noneSentinel matches null but NOT entities lacking the field', () => {
    expect(matches('assignee:none', { assignee: null })).toBe(true);
    expect(matches('assignee:none', { assignee: 'claude' })).toBe(false);
    // A page/playbook entry has no `assignee` key at all → must NOT match `:none`
    // (otherwise every page/playbook would leak into `assignee:none`).
    expect(matches('assignee:none', { type: 'page' })).toBe(false);
    expect(matches('project:none', { project: null })).toBe(true); // standalone ticket
    expect(matches('project:none', { type: 'playbook' })).toBe(false); // no project key
  });

  it('jira substring with case-insensitive system selection', () => {
    const item = { externalIds: [{ system: 'JIRA', id: 'PROJ-123', url: null }] };
    expect(matches('jirt:PROJ-123', item)).toBe(true);
    expect(matches('jirt:proj', item)).toBe(true); // substring + case-insensitive
    expect(matches('jirt:NOPE', item)).toBe(false);
  });

  it('externalid flattened "system:id" haystack', () => {
    const item = { externalIds: [{ system: 'github', id: 'gh-42', url: null }] };
    expect(matches('externalid:gh-42', item)).toBe(true);
    expect(matches('externalid:nope', item)).toBe(false);
  });

  it('negation of a missing field includes field-less entities (AQL parity)', () => {
    // -status:done on a page (no status) → NOT(false) → true. Documented behavior.
    expect(matches('-status:done', { type: 'page' })).toBe(true);
    expect(matches('-status:done', { type: 'ticket', status: 'done' })).toBe(false);
  });
});

describe('splitPaletteQuery — config-driven aliases', () => {
  const aliases = { x: 'ticket', proj: 'project' } as const;

  it('uses a custom alias map', () => {
    expect(splitPaletteQuery('x:', aliases)).toEqual({ aqlExpr: 'kind:ticket', fuzzy: '' });
    expect(splitPaletteQuery('proj:', aliases)).toEqual({ aqlExpr: 'kind:project', fuzzy: '' });
  });

  it('built-in aliases no longer apply when a custom map is supplied', () => {
    // 't' is not in the custom map → stays free text, not kind:ticket.
    expect(splitPaletteQuery('t:', aliases)).toEqual({ aqlExpr: '', fuzzy: 't:' });
  });
});

describe('splitPaletteQuery — default-scope injection', () => {
  const scope = (q: string, defaultScope: 'all' | 'project' | 'ticket') =>
    splitPaletteQuery(q, undefined, { defaultScope });

  it('injects kind:<scope> when the box has no explicit prefix', () => {
    expect(scope('payment', 'project')).toEqual({ aqlExpr: 'kind:project', fuzzy: 'payment' });
    expect(scope('status:open', 'project')).toEqual({
      aqlExpr: 'kind:project status:open',
      fuzzy: '',
    });
  });

  it('an explicit prefix overrides the default scope (no double-gate)', () => {
    expect(scope('t: payment', 'project')).toEqual({
      aqlExpr: 'kind:ticket',
      fuzzy: 'payment',
    });
    expect(scope('kind:playbook', 'project')).toEqual({ aqlExpr: 'kind:playbook', fuzzy: '' });
  });

  it('the empty box and whitespace-only box search everything', () => {
    expect(scope('', 'project')).toEqual({ aqlExpr: '', fuzzy: '' });
    expect(scope('   ', 'project')).toEqual({ aqlExpr: '', fuzzy: '' });
  });

  it('a leading all: escape searches everything regardless of scope', () => {
    expect(scope('all: payment', 'project')).toEqual({ aqlExpr: '', fuzzy: 'payment' });
    expect(scope('all:', 'ticket')).toEqual({ aqlExpr: '', fuzzy: '' });
  });

  it('defaultScope=all never injects', () => {
    expect(scope('payment', 'all')).toEqual({ aqlExpr: '', fuzzy: 'payment' });
  });

  it('the injected gate compiles and filters by kind', () => {
    const { aqlExpr } = scope('status:open', 'project');
    const r = compileQuery(aqlExpr, PALETTE_FIELDS);
    expect(r.query).not.toBeNull();
    expect(r.query!.predicate({ type: 'project', status: 'open' }, { now: 0 })).toBe(true);
    expect(r.query!.predicate({ type: 'ticket', status: 'open' }, { now: 0 })).toBe(false);
  });

  it('an explicit-boolean base is parenthesized so scope ANDs correctly', () => {
    const { aqlExpr } = splitPaletteQuery('status:open OR status:done', undefined, {
      defaultScope: 'project',
    });
    expect(aqlExpr).toBe('kind:project (status:open OR status:done)');
    const r = compileQuery(aqlExpr, PALETTE_FIELDS);
    expect(r.query).not.toBeNull();
    expect(r.query!.predicate({ type: 'project', status: 'done' }, { now: 0 })).toBe(true);
    expect(r.query!.predicate({ type: 'ticket', status: 'done' }, { now: 0 })).toBe(false);
  });
});
