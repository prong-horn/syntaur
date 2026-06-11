import { describe, it, expect } from 'vitest';
import {
  boardItemToQueryItem,
  filterBoardItems,
} from '../../dashboard/src/lib/queryFilter';
import type { AssignmentBoardItem } from '../../dashboard/src/hooks/useProjects';
import { compileQuery } from '../utils/query/index.js';
import { buildQueryRegistry } from '../utils/fact-registry.js';
import type { FactDeclaration } from '../utils/fact-registry.js';

// Fixed clock so every relative-date assertion is deterministic (never wall-clock).
const NOW = Date.parse('2026-06-09T12:00:00Z');

// The custom vocabulary this feature relies on: a bool fact (qaPassed) and a
// plan-bound attestation (codeReview → codeReviewApproved + codeReviewApprovedBy …).
const DECLS: FactDeclaration[] = [
  { name: 'qaPassed', type: 'bool' },
  { name: 'codeReview', type: 'attestation', binds: 'plan' },
];
const REGISTRY = buildQueryRegistry(DECLS);

/** Compile against the CUSTOM registry (the dashboard always does this so custom
 * facts resolve), throwing on compile error to surface a bad query in a test. */
function compile(query: string) {
  const { query: compiled, errors } = compileQuery(query, REGISTRY);
  if (!compiled) throw new Error(`compile failed: ${errors.map((e) => e.message).join('; ')}`);
  return compiled;
}

let idSeq = 0;
function makeItem(overrides: Partial<AssignmentBoardItem> = {}): AssignmentBoardItem {
  idSeq += 1;
  return {
    id: `a-${idSeq}`,
    slug: `slug-${idSeq}`,
    title: `Item ${idSeq}`,
    status: 'in_progress',
    type: 'feature',
    priority: 'high',
    assignee: 'claude',
    dependsOn: [],
    links: [],
    tags: [],
    created: '2026-06-01T10:00:00Z',
    updated: '2026-06-08T10:00:00Z',
    archived: false,
    archivedAt: null,
    archivedReason: null,
    completedAt: null,
    statusAge: 86_400_000,
    phaseAge: null,
    phase: 'in_progress',
    disposition: 'active',
    pinned: false,
    facts: {},
    projectSlug: 'syntaur',
    projectTitle: 'Syntaur',
    blockedReason: null,
    availableTransitions: [],
    projectWorkspace: null,
    ...overrides,
  };
}

/** A fresh, valid attestation export block (codeReview approved by agent:codex). */
function validReviewFacts(actor = 'agent:codex'): Record<string, boolean | number | string[]> {
  return {
    codeReview: true,
    codeReviewApproved: true,
    codeReviewChangesRequested: false,
    codeReviewBy: [actor],
    codeReviewApprovedBy: [actor],
  };
}

/** A STALE attestation: computeFacts drops invalid records, so all exports are
 * the empty/false shape (no valid record survived the digest/HEAD check). */
function staleReviewFacts(): Record<string, boolean | number | string[]> {
  return {
    codeReview: false,
    codeReviewApproved: false,
    codeReviewChangesRequested: false,
    codeReviewBy: [],
    codeReviewApprovedBy: [],
  };
}

function slugsOf(items: AssignmentBoardItem[]): string[] {
  return items.map((i) => i.slug).sort();
}

// ── boardItemToQueryItem materialization ─────────────────────────────────────
describe('boardItemToQueryItem', () => {
  it('spreads facts and maps core/virtual fields onto the QueryItem', () => {
    const item = makeItem({
      title: 'Derived Status Engine',
      slug: 'mat',
      projectTitle: 'Syntaur Meta',
      projectSlug: 'syntaur-meta',
      completedAt: '2026-06-02T10:00:00Z',
      statusAge: 3 * 86_400_000,
      facts: { qaPassed: true, ...validReviewFacts() },
    });
    const q = boardItemToQueryItem(item);
    expect(q.qaPassed).toBe(true);
    expect(q.codeReviewApprovedBy).toEqual(['agent:codex']);
    expect(q.project).toBe('syntaur-meta');
    expect(q.completedAt).toBe('2026-06-02T10:00:00Z');
    expect(q.statusAge).toBe(3 * 86_400_000);
    // searchText haystack = title + slug + projectTitle + projectSlug
    expect(q.searchText).toBe('Derived Status Engine mat Syntaur Meta syntaur-meta');
  });
});

// ── AC5/AC6: custom vocabulary filtering ─────────────────────────────────────
describe('AC5/AC6 — custom fact + attestation vocabulary selects the right items', () => {
  it('qaPassed:true AND codeReviewApproved:true selects only items with both', () => {
    const both = makeItem({ slug: 'both', facts: { qaPassed: true, ...validReviewFacts() } });
    const onlyQa = makeItem({ slug: 'only-qa', facts: { qaPassed: true, ...staleReviewFacts() } });
    const onlyReview = makeItem({ slug: 'only-review', facts: { qaPassed: false, ...validReviewFacts() } });
    const neither = makeItem({ slug: 'neither', facts: { qaPassed: false, ...staleReviewFacts() } });

    const compiled = compile('qaPassed:true AND codeReviewApproved:true');
    const matched = filterBoardItems([both, onlyQa, onlyReview, neither], compiled, { now: NOW });
    expect(slugsOf(matched)).toEqual(['both']);
  });

  it('codeReviewApprovedBy:"agent:codex" matches via list-contains on the actor export', () => {
    const byCodex = makeItem({ slug: 'by-codex', facts: validReviewFacts('agent:codex') });
    const byHuman = makeItem({ slug: 'by-human', facts: validReviewFacts('human:brennen') });
    const none = makeItem({ slug: 'no-review', facts: staleReviewFacts() });

    const compiled = compile('codeReviewApprovedBy:"agent:codex"');
    const matched = filterBoardItems([byCodex, byHuman, none], compiled, { now: NOW });
    expect(slugsOf(matched)).toEqual(['by-codex']);
  });

  it('phase: and disposition: filters select correctly', () => {
    const ready = makeItem({ slug: 'ready', phase: 'ready_to_implement', disposition: 'active' });
    const blocked = makeItem({ slug: 'blocked', phase: 'ready_to_implement', disposition: 'blocked' });
    const review = makeItem({ slug: 'review', phase: 'review', disposition: 'active' });

    const byPhase = filterBoardItems(
      [ready, blocked, review],
      compile('phase:ready_to_implement'),
      { now: NOW },
    );
    expect(slugsOf(byPhase)).toEqual(['blocked', 'ready']);

    const flagship = filterBoardItems(
      [ready, blocked, review],
      compile('phase:ready_to_implement AND disposition:blocked'),
      { now: NOW },
    );
    expect(slugsOf(flagship)).toEqual(['blocked']);
  });
});

// ── stale attestation excludes from codeReviewApproved:true ───────────────────
describe('stale attestation → export facts false → excluded', () => {
  it('an item with a stale review is excluded by codeReviewApproved:true', () => {
    const fresh = makeItem({ slug: 'fresh', facts: validReviewFacts() });
    const stale = makeItem({ slug: 'stale', facts: staleReviewFacts() });
    const matched = filterBoardItems([fresh, stale], compile('codeReviewApproved:true'), { now: NOW });
    expect(slugsOf(matched)).toEqual(['fresh']);
  });
});

// ── workspace / archived live OUTSIDE the query ───────────────────────────────
describe('workspace + archived pre-filters (page options, not AQL)', () => {
  const a = makeItem({ slug: 'ws-syntaur', projectWorkspace: 'syntaur' });
  const b = makeItem({ slug: 'ws-other', projectWorkspace: 'other' });
  const c = makeItem({ slug: 'ungrouped', projectWorkspace: null });
  const archived = makeItem({ slug: 'archived', projectWorkspace: 'syntaur', archived: true });

  it('workspace filter excludes other-workspace items regardless of the query', () => {
    const matched = filterBoardItems([a, b, c, archived], compile('*'), {
      workspace: 'syntaur',
      now: NOW,
    });
    // archived is excluded by default even though it is in the syntaur workspace.
    expect(slugsOf(matched)).toEqual(['ws-syntaur']);
  });

  it('workspace _ungrouped keeps only null-workspace items', () => {
    const matched = filterBoardItems([a, b, c], compile('*'), { workspace: '_ungrouped', now: NOW });
    expect(slugsOf(matched)).toEqual(['ungrouped']);
  });

  it('archived items are excluded by default but kept with includeArchived', () => {
    expect(slugsOf(filterBoardItems([a, archived], compile('*'), { now: NOW }))).toEqual([
      'ws-syntaur',
    ]);
    expect(
      slugsOf(filterBoardItems([a, archived], compile('*'), { includeArchived: true, now: NOW })),
    ).toEqual(['archived', 'ws-syntaur']);
  });

  it('compiled = null (empty/invalid query) matches all, subject to pre-filters only', () => {
    const all = filterBoardItems([a, b, c, archived], null, { now: NOW });
    expect(slugsOf(all)).toEqual(['ungrouped', 'ws-other', 'ws-syntaur']); // archived still excluded
    const scoped = filterBoardItems([a, b, c, archived], null, { workspace: 'syntaur', now: NOW });
    expect(slugsOf(scoped)).toEqual(['ws-syntaur']);
  });
});

// ── searchText parity ─────────────────────────────────────────────────────────
describe('search parity with the materialized haystack', () => {
  it('search:"..." matches title + slug + projectTitle + projectSlug', () => {
    const byTitle = makeItem({ slug: 'x1', title: 'Derived Status Engine' });
    const bySlug = makeItem({ slug: 'login-flow', title: 'Auth' });
    const byProject = makeItem({ slug: 'x2', title: 'Misc', projectTitle: 'Payments Service', projectSlug: 'pay' });
    const miss = makeItem({ slug: 'x3', title: 'Unrelated', projectTitle: 'Other', projectSlug: 'other' });

    expect(slugsOf(filterBoardItems([byTitle, miss], compile('search:"derived status"'), { now: NOW }))).toEqual(['x1']);
    expect(slugsOf(filterBoardItems([bySlug, miss], compile('search:login'), { now: NOW }))).toEqual(['login-flow']);
    expect(slugsOf(filterBoardItems([byProject, miss], compile('search:payments'), { now: NOW }))).toEqual(['x2']);
  });
});

// ── AC8: date / time semantics with a fixed now ───────────────────────────────
describe('AC8 — date/time predicates resolve against the injected now', () => {
  it('completedAt < -1mo matches a terminal item with an old completion', () => {
    // now = 2026-06-09; one month ago ≈ 2026-05-09 (engine uses 30d for `mo`).
    const oldDone = makeItem({
      slug: 'old-done',
      status: 'completed',
      completedAt: '2026-04-01T10:00:00Z',
    });
    const recentDone = makeItem({
      slug: 'recent-done',
      status: 'completed',
      completedAt: '2026-06-08T10:00:00Z',
    });
    const notDone = makeItem({ slug: 'open', completedAt: null });

    const matched = filterBoardItems(
      [oldDone, recentDone, notDone],
      compile('completedAt < -1mo'),
      { now: NOW },
    );
    // null completedAt never satisfies a comparison; recent is within the month.
    expect(slugsOf(matched)).toEqual(['old-done']);
  });

  it('created > -36h OR updated > -36h evaluates per-field against now', () => {
    const recentlyUpdated = makeItem({
      slug: 'fresh-update',
      created: '2026-06-01T10:00:00Z',
      updated: '2026-06-09T09:00:00Z', // 3h ago
    });
    const recentlyCreated = makeItem({
      slug: 'fresh-create',
      created: '2026-06-09T06:00:00Z', // 6h ago
      updated: '2026-06-01T10:00:00Z',
    });
    const stale = makeItem({
      slug: 'cold',
      created: '2026-05-01T10:00:00Z',
      updated: '2026-05-02T10:00:00Z',
    });

    const matched = filterBoardItems(
      [recentlyUpdated, recentlyCreated, stale],
      compile('created > -36h OR updated > -36h'),
      { now: NOW },
    );
    expect(slugsOf(matched)).toEqual(['fresh-create', 'fresh-update']);
  });
});

// ── AC7: a non-default custom status id is matched by status:<id> ─────────────
describe('AC7 — evaluator matches an arbitrary custom status id', () => {
  it('status:awaiting_triage matches an item whose status is that custom id', () => {
    const custom = makeItem({ slug: 'custom', status: 'awaiting_triage' });
    const other = makeItem({ slug: 'other', status: 'in_progress' });
    const matched = filterBoardItems([custom, other], compile('status:awaiting_triage'), { now: NOW });
    expect(slugsOf(matched)).toEqual(['custom']);
  });
});
