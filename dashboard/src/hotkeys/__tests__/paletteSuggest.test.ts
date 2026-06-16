import { describe, it, expect } from 'vitest';
import { suggestPalette, type SuggestContext } from '../paletteSuggest';

const ctx: SuggestContext = {
  aliases: { a: 'assignment', p: 'project', t: 'todo', s: 'server', pb: 'playbook' },
  fields: [
    'kind',
    'status',
    'tag',
    'tags',
    'assignee',
    'type',
    'project',
    'externalid',
    'jira',
    'title',
    'search',
  ],
  values: {
    status: ['open', 'in_progress', 'done', 'closed'],
    type: ['feature', 'bug', 'chore'],
    tag: ['backend', 'frontend'],
    assignee: ['claude', 'brennen'],
    externalid: ['PROJ-1'],
  },
};

// externalIds disabled: jira/externalid absent from fields, no externalid values.
const ctxNoExt: SuggestContext = {
  ...ctx,
  fields: ctx.fields.filter((f) => f !== 'jira' && f !== 'externalid'),
  values: { ...ctx.values, externalid: [] },
};

describe('suggestPalette — prefix / field category', () => {
  it('empty input offers alias prefixes + field names at the caret', () => {
    const s = suggestPalette('', 0, ctx);
    expect(s.some((x) => x.kind === 'prefix' && x.insert === 'a:')).toBe(true);
    expect(s.some((x) => x.kind === 'field' && x.insert === 'status:')).toBe(true);
    expect(s.every((x) => x.replace[0] === 0 && x.replace[1] === 0)).toBe(true);
  });

  it('a bare-word fragment filters fields by prefix', () => {
    expect(suggestPalette('stat', 4, ctx)).toEqual([
      { label: 'status:', insert: 'status:', replace: [0, 4], kind: 'field' },
    ]);
  });

  it('a fragment matches both an alias prefix and a field', () => {
    const s = suggestPalette('a', 1, ctx);
    expect(s.some((x) => x.kind === 'prefix' && x.insert === 'a:')).toBe(true);
    expect(s.some((x) => x.kind === 'field' && x.insert === 'assignee:')).toBe(true);
    expect(s.every((x) => x.replace[0] === 0 && x.replace[1] === 1)).toBe(true);
  });

  it('suggests after a negation prefix, replacing only the word span', () => {
    const s = suggestPalette('-stat', 5, ctx);
    expect(s).toEqual([{ label: 'status:', insert: 'status:', replace: [1, 5], kind: 'field' }]);
  });

  it('does not nag once a field is followed by a colon', () => {
    // caret inside the field name of a complete `status:done` atom → nothing.
    expect(suggestPalette('status:done', 3, ctx)).toEqual([]);
  });
});

describe('suggestPalette — value category', () => {
  it('offers all values right after `field:`', () => {
    const s = suggestPalette('status:', 7, ctx);
    expect(s.map((x) => x.insert)).toEqual(['open', 'in_progress', 'done', 'closed']);
    expect(s.every((x) => x.kind === 'value' && x.replace[0] === 7 && x.replace[1] === 7)).toBe(true);
  });

  it('filters values by the partial fragment with an exact replace span', () => {
    expect(suggestPalette('status:op', 9, ctx)).toEqual([
      { label: 'open', insert: 'open', replace: [7, 9], kind: 'value' },
    ]);
  });

  it('a fully-typed value is not re-suggested (don’t nag)', () => {
    expect(suggestPalette('status:open', 11, ctx)).toEqual([]);
  });

  it('free-form fields (title/search) yield no value suggestions', () => {
    expect(suggestPalette('title:foo', 9, ctx)).toEqual([]);
    expect(suggestPalette('search:foo', 10, ctx)).toEqual([]);
  });

  it('quotes a value that needs quoting', () => {
    // type value `in` → matches `in_progress` (no space, no quote needed).
    const s = suggestPalette('status:in', 9, ctx);
    expect(s).toEqual([
      { label: 'in_progress', insert: 'in_progress', replace: [7, 9], kind: 'value' },
    ]);
  });

  it('quotes reserved keywords and special-char values via quoteQueryValue', () => {
    const ctxKw: SuggestContext = {
      ...ctx,
      values: {
        ...ctx.values,
        status: ['or', 'in progress'],
        assignee: ['agent:codex'],
      },
    };
    // `or` is an AQL keyword → must be quoted, else it parses as a boolean op.
    expect(suggestPalette('status:o', 8, ctxKw)).toEqual([
      { label: 'or', insert: '"or"', replace: [7, 8], kind: 'value' },
    ]);
    // space → quoted.
    expect(suggestPalette('status:in', 9, ctxKw)).toEqual([
      { label: 'in progress', insert: '"in progress"', replace: [7, 9], kind: 'value' },
    ]);
    // `:` → quoted.
    expect(suggestPalette('assignee:age', 12, ctxKw)).toEqual([
      { label: 'agent:codex', insert: '"agent:codex"', replace: [9, 12], kind: 'value' },
    ]);
  });
});

describe('suggestPalette — replace-span fidelity', () => {
  it('completing a value mid-query never corrupts the rest', () => {
    const input = 'a: status:op';
    const s = suggestPalette(input, input.length, ctx);
    expect(s).toEqual([{ label: 'open', insert: 'open', replace: [10, 12], kind: 'value' }]);
    // Apply the splice exactly as CommandPalette will.
    const { replace, insert } = s[0];
    const next = input.slice(0, replace[0]) + insert + input.slice(replace[1]);
    expect(next).toBe('a: status:open');
  });

  it('completing right after a colon preserves trailing text', () => {
    const input = 'status: tag:x';
    // caret right after the first colon (offset 7).
    const s = suggestPalette(input, 7, ctx);
    expect(s.length).toBeGreaterThan(0);
    const { replace, insert } = s[0];
    expect(replace).toEqual([7, 7]);
    const next = input.slice(0, replace[0]) + insert + input.slice(replace[1]);
    expect(next).toBe('status:open tag:x');
  });
});

describe('suggestPalette — external-ID gating', () => {
  it('omits jira/externalid fields when externalIds is disabled', () => {
    expect(suggestPalette('jir', 3, ctxNoExt).some((x) => x.insert === 'jira:')).toBe(false);
    expect(suggestPalette('exter', 5, ctxNoExt).some((x) => x.insert === 'externalid:')).toBe(false);
    // Sanity: with external IDs enabled, jira IS suggested.
    expect(suggestPalette('jir', 3, ctx).some((x) => x.insert === 'jira:')).toBe(true);
  });

  it('offers no externalid values when the source list is empty', () => {
    expect(suggestPalette('externalid:', 11, ctxNoExt)).toEqual([]);
  });
});

describe('suggestPalette — resilience (never throws)', () => {
  it('unlexable input degrades to no suggestions', () => {
    expect(suggestPalette('status:/x', 9, ctx)).toEqual([]);
    expect(suggestPalette('foo"bar', 7, ctx)).toEqual([]); // unterminated string
  });

  it('never throws on assorted half-typed / weird input', () => {
    for (const q of ['', ' ', '(', ')', '::', 'a:::', 'status:"x', '@#$', 'tag:(a b', 'NOT ']) {
      expect(() => suggestPalette(q, q.length, ctx)).not.toThrow();
    }
  });
});
