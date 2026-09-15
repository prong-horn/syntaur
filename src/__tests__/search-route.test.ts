import { describe, it, expect } from 'vitest';
import { parseFileKinds, type SearchHit } from '../search/types.js';
import { routeForHit, slugifyHeading, FILE_KIND_TO_TAB } from '../search/route.js';

describe('parseFileKinds', () => {
  it('resolves singular + plural/common forms to canonical FileKind', () => {
    expect(parseFileKinds('comments,plans')).toEqual(['comments', 'plan']);
    expect(parseFileKinds('journal,journals')).toEqual(['journal']);
    expect(parseFileKinds('decisions')).toEqual(['decision-record']);
    expect(parseFileKinds('decision-record')).toEqual(['decision-record']);
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(parseFileKinds('  PLANS , Comments ')).toEqual(['plan', 'comments']);
  });

  it('dedupes kinds that resolve to the same canonical', () => {
    expect(parseFileKinds('plan,plans')).toEqual(['plan']);
  });

  it('drops empty entries and returns [] for blank input', () => {
    expect(parseFileKinds('')).toEqual([]);
    expect(parseFileKinds(' , ,')).toEqual([]);
  });

  it('throws on an unknown kind, listing valid kinds', () => {
    expect(() => parseFileKinds('comments,bogus')).toThrow(/Unknown file kind "bogus"/);
    expect(() => parseFileKinds('bogus')).toThrow(/Valid kinds:/);
  });
});

function hit(partial: Partial<SearchHit>): SearchHit {
  return {
    path: '/x',
    projectSlug: null,
    ticketSlug: null,
    ticketId: null,
    standalone: false,
    fileKind: 'ticket',
    title: 't',
    score: 0,
    snippet: '',
    matches: [],
    line: 1,
    route: '',
    ...partial,
  };
}

describe('routeForHit', () => {
  it('builds a nested ticket route with tab + section anchor for a markdown-rendered kind', () => {
    const route = routeForHit(
      hit({
        fileKind: 'plan',
        projectSlug: 'proj',
        ticketSlug: 'my-ticket',
        ticketId: 'ticket-uuid-1',
        standalone: false,
        section: 'Open Questions',
      }),
    );
    expect(route).toBe('/t/ticket-uuid-1?tab=file:plan.md#open-questions');
  });

  it('keeps a section anchor for a decision-record hit (markdown-rendered pane)', () => {
    const route = routeForHit(
      hit({
        fileKind: 'decision-record',
        projectSlug: 'proj',
        ticketSlug: 'a1',
        ticketId: 'ticket-uuid-2',
        standalone: false,
        section: 'Why Postgres',
      }),
    );
    expect(route).toBe('/t/ticket-uuid-2?tab=file:decision-record.md#why-postgres');
  });

  it('omits the section anchor for ticket (summary pane builds SectionCards, no heading ids)', () => {
    const route = routeForHit(
      hit({
        fileKind: 'ticket',
        projectSlug: 'proj',
        ticketSlug: 'my-ticket',
        ticketId: 'ticket-uuid-3',
        standalone: false,
        section: 'Acceptance Criteria',
      }),
    );
    expect(route).toBe('/t/ticket-uuid-3?tab=summary');
    expect(route).not.toContain('#');
  });

  it('keeps a section anchor for comments hits', () => {
    const route = routeForHit(
      hit({
        fileKind: 'comments',
        projectSlug: 'proj',
        ticketSlug: 'my-ticket',
        ticketId: 'ticket-uuid-4',
        standalone: false,
        section: 'Open Questions',
      }),
    );
    expect(route).toBe('/t/ticket-uuid-4?tab=file:comments.md#open-questions');
  });

  it('keeps a section anchor for progress hits', () => {
    const route = routeForHit(
      hit({
        fileKind: 'progress',
        projectSlug: 'proj',
        ticketSlug: 'my-ticket',
        ticketId: 'ticket-uuid-5',
        standalone: false,
        section: 'Day 1',
      }),
    );
    expect(route).toBe('/t/ticket-uuid-5?tab=file:progress.md#day-1');
  });

  it('builds a nested route without an anchor when no section', () => {
    const route = routeForHit(
      hit({
        fileKind: 'plan',
        projectSlug: 'proj',
        ticketSlug: 'a1',
        ticketId: 'ticket-uuid-6',
        standalone: false,
      }),
    );
    expect(route).toBe('/t/ticket-uuid-6?tab=file:plan.md');
  });

  it('builds a standalone route off the ticket id', () => {
    const route = routeForHit(
      hit({
        fileKind: 'plan',
        ticketId: 'uuid-123',
        standalone: true,
      }),
    );
    expect(route).toBe('/t/uuid-123?tab=file:plan.md');
  });

  it('maps each FileKind to an existing TicketDetail tab', () => {
    expect(FILE_KIND_TO_TAB.ticket).toBe('summary');
    expect(FILE_KIND_TO_TAB.plan).toBe('file:plan.md');
    expect(FILE_KIND_TO_TAB.journal).toBe('file:journal.md');
    expect(FILE_KIND_TO_TAB['decision-record']).toBe('file:decision-record.md');
  });

  it('routes journal hits to the journal tab', () => {
    const route = routeForHit(
      hit({
        fileKind: 'journal',
        ticketId: 'ticket-uuid-7',
        section: 'Day 1',
      }),
    );
    expect(route).toBe('/t/ticket-uuid-7?tab=file:journal.md#day-1');
  });
});

describe('slugifyHeading', () => {
  it('lowercases, strips punctuation, and hyphenates spaces', () => {
    expect(slugifyHeading('Open Questions')).toBe('open-questions');
    expect(slugifyHeading('Task 1: Build the Indexer!')).toBe('task-1-build-the-indexer');
    expect(slugifyHeading('  Multiple   Spaces  ')).toBe('multiple-spaces');
  });
});
