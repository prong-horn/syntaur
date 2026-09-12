import { describe, it, expect } from 'vitest';
import { contentHitsToEntries } from '../paletteIndex';
import type { ContentHit } from '../../hooks/useContentSearch';

const nestedHit: ContentHit = {
  path: '/p/acme/tickets/login/comments.md',
  projectSlug: 'acme',
  ticketSlug: 'login',
  ticketId: 'a-1',
  standalone: false,
  fileKind: 'comments',
  title: 'Fix login',
  score: 0.1,
  snippet: 'the auth token expires too early',
  matches: [{ start: 4, end: 8 }],
  line: 12,
  section: 'Auth',
  route: '/t/a-1?tab=comments#auth',
};

const standaloneHit: ContentHit = {
  path: '/tickets/uuid-9/plan.md',
  projectSlug: null,
  ticketSlug: 'oneoff',
  ticketId: 'uuid-9',
  standalone: true,
  fileKind: 'plan',
  title: 'One off task',
  score: 0.2,
  snippet: 'step one is to set up the repo',
  matches: [{ start: 0, end: 4 }],
  line: 3,
  route: '/t/uuid-9?tab=plan',
};

const nestedPlanHit: ContentHit = {
  path: '/p/acme/tickets/login/plan.md',
  projectSlug: 'acme',
  ticketSlug: 'login',
  ticketId: 'a-1',
  standalone: false,
  fileKind: 'plan',
  title: 'Fix login',
  score: 0.15,
  snippet: 'always branch from main',
  matches: [{ start: 7, end: 13 }],
  line: 1,
  route: '/t/a-1?tab=plan',
};

describe('contentHitsToEntries', () => {
  const entries = contentHitsToEntries([nestedHit, standaloneHit, nestedPlanHit]);

  it('maps every hit to a content-typed entry', () => {
    expect(entries).toHaveLength(3);
    for (const e of entries) expect(e.type).toBe('content');
  });

  it('uses the hit route verbatim for project-nested ticket-pane hits', () => {
    const e = entries[0];
    expect(e.route).toBe('/t/a-1?tab=comments#auth');
    expect(e.route.startsWith('/w/')).toBe(false);
  });

  it('leaves a standalone hit UNPREFIXED (route === hit.route)', () => {
    const e = entries[1];
    expect(e.route).toBe(standaloneHit.route);
    expect(e.route.startsWith('/w/')).toBe(false);
  });

  it('leaves a nested plan hit UNPREFIXED', () => {
    const e = entries[2];
    expect(e.route).toBe('/t/a-1?tab=plan');
    expect(e.route.startsWith('/w/')).toBe(false);
  });

  it('carries the snippet + match ranges for HTML-safe <mark> rendering', () => {
    expect(entries[0].snippet).toBe(nestedHit.snippet);
    expect(entries[0].snippetMatches).toEqual(nestedHit.matches);
    expect(entries[2].snippet).toBe(nestedPlanHit.snippet);
    expect(entries[2].snippetMatches).toEqual(nestedPlanHit.matches);
  });

  it('builds a "<slug> › <section ?? fileKind>" title', () => {
    expect(entries[0].title).toBe('login › Auth');
    expect(entries[1].title).toBe('oneoff › plan');
    expect(entries[2].title).toBe('login › plan');
  });
});
