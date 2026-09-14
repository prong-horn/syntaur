import { describe, it, expect } from 'vitest';
import {
  boardItemToQueryItem,
  filterBoardItems,
} from '../../dashboard/src/lib/queryFilter';
import type { TicketBoardItem } from '../../dashboard/src/hooks/useProjects';
import { compileQuery } from '../utils/query/index.js';
import { buildQueryRegistry } from '../utils/query/registry.js';

const NOW = Date.parse('2026-06-09T12:00:00Z');
const REGISTRY = buildQueryRegistry();

function compile(query: string) {
  const { query: compiled, errors } = compileQuery(query, REGISTRY);
  if (!compiled) throw new Error(`compile failed: ${errors.map((e) => e.message).join('; ')}`);
  return compiled;
}

let idSeq = 0;
function makeItem(overrides: Partial<TicketBoardItem> = {}): TicketBoardItem {
  idSeq += 1;
  return {
    id: `a-${idSeq}`,
    slug: `slug-${idSeq}`,
    title: `Item ${idSeq}`,
    status: 'in_progress',
    template: 'feature',
    priority: 'high',
    assignee: 'claude',
    depends_on: [],
    links: [],
    tags: [],
    created: '2026-06-01T10:00:00Z',
    updated: '2026-06-08T10:00:00Z',
    blocked: null,
    parked: null,
    completedAt: null,
    statusAge: 86_400_000,
    projectSlug: 'syntaur',
    projectTitle: 'Syntaur',
    availableVerbs: [],
    ...overrides,
  } as TicketBoardItem;
}

function slugsOf(items: TicketBoardItem[]): string[] {
  return items.map((i) => i.slug).sort();
}

describe('boardItemToQueryItem', () => {
  it('maps core fields onto the QueryItem', () => {
    const item = makeItem({
      title: 'Derived Status Engine',
      slug: 'mat',
      projectTitle: 'Syntaur Meta',
      projectSlug: 'syntaur-meta',
      completedAt: '2026-06-02T10:00:00Z',
      statusAge: 3 * 86_400_000,
    });
    const q = boardItemToQueryItem(item);
    expect(q.project).toBe('syntaur-meta');
    expect(q.completedAt).toBe('2026-06-02T10:00:00Z');
    expect(q.statusAge).toBe(3 * 86_400_000);
    expect(q.searchText).toBe('Derived Status Engine mat Syntaur Meta syntaur-meta');
  });
});

describe('v2 built-in query filtering', () => {
  it('status and blocked filters select the right items', () => {
    const ready = makeItem({ slug: 'ready', status: 'ready' });
    const blocked = makeItem({
      slug: 'blocked',
      status: 'in_progress',
      blocked: 'waiting',
    });
    const review = makeItem({ slug: 'review', status: 'review' });

    expect(slugsOf(filterBoardItems([ready, blocked, review], compile('status:ready'), { now: NOW }))).toEqual(['ready']);
    expect(slugsOf(filterBoardItems([ready, blocked, review], compile('blocked:true'), { now: NOW }))).toEqual(['blocked']);
  });
});

describe('archived pre-filters (page options, not AQL)', () => {
  const active = makeItem({ slug: 'active' });
  const archived = makeItem({ slug: 'archived', parked: 'on hold' });

  it('archived items are excluded by default but kept with includeArchived', () => {
    expect(slugsOf(filterBoardItems([active, archived], compile('*'), { now: NOW }))).toEqual(['active']);
    expect(
      slugsOf(filterBoardItems([active, archived], compile('*'), { includeArchived: true, now: NOW })),
    ).toEqual(['active', 'archived']);
  });
});

describe('search parity with the materialized haystack', () => {
  it('search:"..." matches title + slug + projectTitle + projectSlug', () => {
    const byTitle = makeItem({ slug: 'x1', title: 'Derived Status Engine' });
    const bySlug = makeItem({ slug: 'login-flow', title: 'Auth' });
    const miss = makeItem({ slug: 'x3', title: 'Unrelated', projectTitle: 'Other', projectSlug: 'other' });

    expect(slugsOf(filterBoardItems([byTitle, miss], compile('search:"derived status"'), { now: NOW }))).toEqual(['x1']);
    expect(slugsOf(filterBoardItems([bySlug, miss], compile('search:login'), { now: NOW }))).toEqual(['login-flow']);
  });
});

describe('date/time predicates resolve against the injected now', () => {
  it('completedAt < -1mo matches an item with an old completion', () => {
    const oldDone = makeItem({
      slug: 'old-done',
      status: 'done',
      completedAt: '2026-04-01T10:00:00Z',
    });
    const recentDone = makeItem({
      slug: 'recent-done',
      status: 'done',
      completedAt: '2026-06-08T10:00:00Z',
    });
    const notDone = makeItem({ slug: 'open', completedAt: null });

    const matched = filterBoardItems(
      [oldDone, recentDone, notDone],
      compile('completedAt < -1mo'),
      { now: NOW },
    );
    expect(slugsOf(matched)).toEqual(['old-done']);
  });
});

describe('evaluator matches arbitrary stage ids', () => {
  it('status:planning matches an item whose status is that stage id', () => {
    const custom = makeItem({ slug: 'custom', status: 'planning' });
    const other = makeItem({ slug: 'other', status: 'in_progress' });
    const matched = filterBoardItems([custom, other], compile('status:planning'), { now: NOW });
    expect(slugsOf(matched)).toEqual(['custom']);
  });
});
