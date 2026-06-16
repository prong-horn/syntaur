import { describe, it, expect } from 'vitest';
import { parseFileKinds, type SearchHit } from '../search/types.js';
import { routeForHit, slugifyHeading, FILE_KIND_TO_TAB } from '../search/route.js';

describe('parseFileKinds', () => {
  it('resolves singular + plural/common forms to canonical FileKind', () => {
    expect(parseFileKinds('comments,plans')).toEqual(['comments', 'plan']);
    expect(parseFileKinds('memory, resources')).toEqual(['memory', 'resource']);
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
    projectWorkspace: null,
    assignmentSlug: null,
    assignmentId: null,
    standalone: false,
    fileKind: 'assignment',
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
  it('builds a nested assignment route with tab + section anchor', () => {
    const route = routeForHit(
      hit({
        fileKind: 'comments',
        projectSlug: 'proj',
        assignmentSlug: 'my-assignment',
        standalone: false,
        section: 'Open Questions',
      }),
    );
    expect(route).toBe('/projects/proj/assignments/my-assignment?tab=comments#open-questions');
  });

  it('builds a nested route without an anchor when no section', () => {
    const route = routeForHit(
      hit({
        fileKind: 'plan',
        projectSlug: 'proj',
        assignmentSlug: 'a1',
        standalone: false,
      }),
    );
    expect(route).toBe('/projects/proj/assignments/a1?tab=plan');
  });

  it('builds a standalone route off the assignment id', () => {
    const route = routeForHit(
      hit({
        fileKind: 'plan',
        assignmentId: 'uuid-123',
        standalone: true,
      }),
    );
    expect(route).toBe('/assignments/uuid-123?tab=plan');
  });

  it('routes memory + resource to their own pages (no tab)', () => {
    expect(
      routeForHit(hit({ fileKind: 'memory', projectSlug: 'proj', itemSlug: 'shell-config' })),
    ).toBe('/projects/proj/memories/shell-config');
    expect(
      routeForHit(hit({ fileKind: 'resource', projectSlug: 'proj', itemSlug: 'dashboard-link' })),
    ).toBe('/projects/proj/resources/dashboard-link');
  });

  it('maps each FileKind to an existing AssignmentDetail tab', () => {
    expect(FILE_KIND_TO_TAB.assignment).toBe('summary');
    expect(FILE_KIND_TO_TAB.plan).toBe('plan');
    expect(FILE_KIND_TO_TAB['decision-record']).toBe('decisions');
  });
});

describe('slugifyHeading', () => {
  it('lowercases, strips punctuation, and hyphenates spaces', () => {
    expect(slugifyHeading('Open Questions')).toBe('open-questions');
    expect(slugifyHeading('Task 1: Build the Indexer!')).toBe('task-1-build-the-indexer');
    expect(slugifyHeading('  Multiple   Spaces  ')).toBe('multiple-spaces');
  });
});
