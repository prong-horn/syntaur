import { describe, it, expect } from 'vitest';
import { compileQuery, type QueryItem } from '@shared/query';
import { rankAll } from '../fuzzy';
import { splitPaletteQuery, PALETTE_FIELDS } from '../paletteQuery';

// Mirrors the CommandPalette pipeline: split → gate → rank. Kept here so the
// integration is exercised without React.
function runPalette<T extends { type: string; title: string; keywords?: string[] }>(
  query: string,
  entries: T[],
): Array<T & { score: number }> {
  const { aqlExpr, fuzzy } = splitPaletteQuery(query);
  let survivors = entries;
  let rankText = fuzzy;
  if (aqlExpr) {
    const result = compileQuery(aqlExpr, PALETTE_FIELDS);
    if (result.query) {
      const { predicate } = result.query;
      survivors = entries.filter((e) => predicate(e as unknown as QueryItem, { now: 0 }));
    } else {
      rankText = query;
    }
  }
  return rankAll(rankText, survivors, 50);
}

const PAGE = { type: 'page', id: 'pg', title: 'Settings', keywords: [] as string[] };
const PROJECT = {
  type: 'project',
  id: 'p1',
  title: 'Billing',
  tags: ['backend'],
  project: 'billing',
  externalIds: [] as Array<{ system: string; id: string; url: string | null }>,
  keywords: [] as string[],
};
const A_PAYMENT = {
  type: 'assignment',
  id: 'a1',
  title: 'Payment flow',
  status: 'in_progress',
  tags: ['backend'],
  assignee: 'claude',
  assignmentType: 'feature',
  project: 'billing',
  externalIds: [{ system: 'jira', id: 'PROJ-123', url: null }],
  keywords: ['PROJ-123', 'jira:PROJ-123'],
};
const A_REFUND = {
  type: 'assignment',
  id: 'a2',
  title: 'Refund logic',
  status: 'done',
  tags: [] as string[],
  assignee: null,
  assignmentType: 'bug',
  project: 'billing',
  externalIds: [] as Array<{ system: string; id: string; url: string | null }>,
  keywords: [] as string[],
};
const SERVER = { type: 'server', id: 'sv', title: 'dev-1', keywords: [] as string[] };

const INDEX = [PAGE, PROJECT, A_PAYMENT, A_REFUND, SERVER];
const titles = (rows: Array<{ title: string }>) => rows.map((r) => r.title);

describe('palette gate + rank integration', () => {
  it('status:done excludes pages/servers/projects (no status field)', () => {
    expect(titles(runPalette('status:done', INDEX))).toEqual(['Refund logic']);
  });

  it('jira:PROJ-123 narrows to the entity carrying that external ID', () => {
    expect(titles(runPalette('jira:PROJ-123', INDEX))).toEqual(['Payment flow']);
  });

  it('a: payment → assignments fuzzy-ranked by "payment"', () => {
    const r = runPalette('a: payment', INDEX);
    expect(r[0].title).toBe('Payment flow');
    // Refund logic has no "payment" subsequence → dropped.
    expect(titles(r)).not.toContain('Refund logic');
  });

  it('pure a: → all assignments in default order (empty fuzzy)', () => {
    expect(titles(runPalette('a:', INDEX))).toEqual(['Payment flow', 'Refund logic']);
  });

  it('bare PROJ-123 finds the item via folded keywords (fuzzy path, no gate)', () => {
    expect(titles(runPalette('PROJ-123', INDEX))).toEqual(['Payment flow']);
  });

  it('a: jira:PROJ payment combines gate + fuzzy', () => {
    expect(titles(runPalette('a: jira:PROJ payment', INDEX))).toEqual(['Payment flow']);
  });

  it('type:feature matches via assignmentType, not the entity kind', () => {
    expect(titles(runPalette('type:feature', INDEX))).toEqual(['Payment flow']);
    expect(titles(runPalette('type:assignment', INDEX))).toEqual([]);
  });

  it('negation of a missing field includes field-less entities, excludes the matched one', () => {
    const t = titles(runPalette('-status:done', INDEX));
    expect(t).toContain('Settings'); // page, no status → NOT(false) → kept
    expect(t).toContain('dev-1'); // server, no status → kept
    expect(t).toContain('Payment flow'); // status in_progress ≠ done → kept
    expect(t).not.toContain('Refund logic'); // status done → excluded
  });

  it('a malformed gate falls back to free-text-only and never throws', () => {
    // Grouping paren → explicit-AQL; `(payment)` fails to compile (bare atom),
    // so it falls back to ranking the original query over all entries.
    expect(() => runPalette('(payment)', INDEX)).not.toThrow();
    const r = runPalette('(payment)', INDEX);
    expect(Array.isArray(r)).toBe(true);
  });
});

describe('palette external-ID boundary', () => {
  const A_LEGACY = {
    type: 'assignment',
    id: 'a3',
    title: 'Legacy import',
    status: 'pending',
    assignmentType: 'chore',
    externalIds: [{ system: 'jira', id: '123-ABC', url: null }],
    keywords: ['123-ABC', 'jira:123-ABC'],
  };

  it('a leading-digit external ID is matchable when quoted', () => {
    expect(titles(runPalette('jira:"123-ABC"', [A_LEGACY]))).toEqual(['Legacy import']);
  });

  it('the same ID is still findable as bare free text via keywords', () => {
    expect(titles(runPalette('123-ABC', [A_LEGACY]))).toEqual(['Legacy import']);
  });
});
