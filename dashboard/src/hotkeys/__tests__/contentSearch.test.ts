import { describe, it, expect } from 'vitest';
import { contentHitsToEntries } from '../paletteIndex';
import type { ContentHit } from '../../hooks/useContentSearch';

// A project-nested assignment hit WITH a project workspace: this is the only
// shape that gets the `/w/<ws>` route prefix.
const nestedHit: ContentHit = {
  path: '/p/acme/assignments/login/comments.md',
  projectSlug: 'acme',
  projectWorkspace: 'syntaur',
  assignmentSlug: 'login',
  assignmentId: 'a-1',
  standalone: false,
  fileKind: 'comments',
  title: 'Fix login',
  score: 0.1,
  snippet: 'the auth token expires too early',
  matches: [{ start: 4, end: 8 }],
  line: 12,
  section: 'Auth',
  route: '/projects/acme/assignments/login?tab=comments#auth',
};

// A standalone assignment hit — has no workspace-prefixed route variant, so it
// must stay UNPREFIXED even if some workspace were present.
const standaloneHit: ContentHit = {
  path: '/assignments/uuid-9/plan.md',
  projectSlug: null,
  projectWorkspace: null,
  assignmentSlug: 'oneoff',
  assignmentId: 'uuid-9',
  standalone: true,
  fileKind: 'plan',
  title: 'One off task',
  score: 0.2,
  snippet: 'step one is to set up the repo',
  matches: [{ start: 0, end: 4 }],
  line: 3,
  route: '/assignments/uuid-9?tab=plan',
};

// A project memory hit — memories have no `/w/...` route variant.
const memoryHit: ContentHit = {
  path: '/p/acme/memories/conventions.md',
  projectSlug: 'acme',
  projectWorkspace: 'syntaur',
  assignmentSlug: null,
  assignmentId: null,
  standalone: false,
  itemSlug: 'conventions',
  fileKind: 'memory',
  title: 'Conventions',
  score: 0.15,
  snippet: 'always branch from main',
  matches: [{ start: 7, end: 13 }],
  line: 1,
  route: '/projects/acme/memories/conventions',
};

describe('contentHitsToEntries', () => {
  const entries = contentHitsToEntries([nestedHit, standaloneHit, memoryHit]);

  it('maps every hit to a content-typed entry', () => {
    expect(entries).toHaveLength(3);
    for (const e of entries) expect(e.type).toBe('content');
  });

  it('prefixes a project-nested assignment-pane hit with /w/<projectWorkspace>', () => {
    const e = entries[0];
    expect(e.route).toBe('/w/syntaur/projects/acme/assignments/login?tab=comments#auth');
    expect(e.route.startsWith('/w/syntaur/projects/')).toBe(true);
  });

  it('leaves a standalone hit UNPREFIXED (route === hit.route, no /w/)', () => {
    const e = entries[1];
    expect(e.route).toBe(standaloneHit.route);
    expect(e.route.startsWith('/w/')).toBe(false);
  });

  it('leaves a memory hit UNPREFIXED (/projects/<p>/memories/..., no /w/)', () => {
    const e = entries[2];
    expect(e.route).toBe('/projects/acme/memories/conventions');
    expect(e.route.startsWith('/w/')).toBe(false);
  });

  it('carries the snippet + match ranges for HTML-safe <mark> rendering', () => {
    expect(entries[0].snippet).toBe(nestedHit.snippet);
    expect(entries[0].snippetMatches).toEqual(nestedHit.matches);
    expect(entries[2].snippet).toBe(memoryHit.snippet);
    expect(entries[2].snippetMatches).toEqual(memoryHit.matches);
  });

  it('builds a "<slug> › <section ?? fileKind>" title', () => {
    expect(entries[0].title).toBe('login › Auth'); // section present
    expect(entries[1].title).toBe('oneoff › plan'); // no section → fileKind
    expect(entries[2].title).toBe('conventions › memory'); // itemSlug fallback
  });
});
