/**
 * Default `SearchProvider` — fuse.js full-text over indexed markdown bodies.
 *
 * The provider returns a NEUTRAL snippet (no highlight markers) plus
 * `matches: MatchRange[]` in snippet-local coordinates, a 1-based `line`, and
 * the nearest preceding `section` heading. Callers format highlighting
 * themselves (CLI `**…**`, API/palette HTML-safe `<mark>`).
 *
 * `extractSnippet` and `nearestSection` are pure exported helpers so they're
 * directly unit-testable. Fuse construction follows `src/tui/hooks/useSearch.ts`
 * (now with `includeMatches`).
 */

import Fuse from 'fuse.js';
import type { FuseResultMatch } from 'fuse.js';
import type { MatchRange, SearchDoc, SearchHit, SearchProvider, SearchQuery } from './types.js';
import { routeForHit } from './route.js';

/** Half-window (chars) on each side of the match offset for the snippet. */
const SNIPPET_RADIUS = 60;

export class FuseProvider implements SearchProvider {
  private docs: SearchDoc[] = [];

  index(docs: SearchDoc[]): void {
    this.docs = docs;
  }

  query(q: SearchQuery, limit: number): SearchHit[] {
    // 1. Pre-filter the doc subset (cheap; keeps Fuse scores undiluted).
    const subset = this.docs.filter((d) => {
      if (q.project !== undefined && d.projectSlug !== q.project) return false;
      if (q.type && q.type.length > 0 && (!d.type || !q.type.includes(d.type))) return false;
      if (q.status && q.status.length > 0 && (!d.status || !q.status.includes(d.status))) return false;
      if (q.in && q.in.length > 0 && !q.in.includes(d.fileKind)) return false;
      return true;
    });

    const fuse = new Fuse(subset, {
      keys: ['title', 'body'],
      threshold: 0.4,
      includeScore: true,
      includeMatches: true,
      ignoreLocation: true,
      minMatchCharLength: 2,
    });

    const results = fuse.search(q.query);

    const hits: SearchHit[] = [];
    for (const result of results) {
      const doc = result.item;
      const score = result.score ?? 0;
      const bodyMatch = pickBodyMatch(result.matches);
      const { snippet, matches, line, section } = extractSnippet(doc.body, bodyMatch, q.query);

      const hit: SearchHit = {
        path: doc.path,
        projectSlug: doc.projectSlug,
        projectWorkspace: doc.projectWorkspace,
        assignmentSlug: doc.assignmentSlug,
        assignmentId: doc.assignmentId,
        standalone: doc.standalone,
        fileKind: doc.fileKind,
        title: doc.title,
        score,
        snippet,
        matches,
        line,
        route: '',
      };
      if (doc.itemSlug !== undefined) hit.itemSlug = doc.itemSlug;
      if (section !== undefined) hit.section = section;
      hit.route = routeForHit(hit);
      hits.push(hit);
    }

    hits.sort((a, b) => a.score - b.score);
    return hits.slice(0, limit);
  }
}

/** First Fuse match on the `body` key (the one we can locate in `doc.body`). */
function pickBodyMatch(
  matches: ReadonlyArray<FuseResultMatch> | undefined,
): FuseResultMatch | undefined {
  if (!matches) return undefined;
  return matches.find((m) => m.key === 'body');
}

export interface SnippetResult {
  /** Neutral text window (no highlight markers). */
  snippet: string;
  /** Match ranges in snippet-local coordinates. */
  matches: MatchRange[];
  /** 1-based line of the match in the source body. */
  line: number;
  /** Nearest preceding markdown heading text, if any. */
  section?: string;
}

/**
 * Produce a neutral snippet window around the first body match (or a substring
 * fallback for `query`), with snippet-local match ranges, the 1-based line, and
 * the nearest preceding `#`-heading section.
 *
 * `bodyMatch` is the Fuse `matches[]` entry for the `body` key (its `indices`
 * are inclusive `[start, end]` tuples). When absent, we fall back to a
 * case-insensitive substring search for `query`. When no offset can be found at
 * all, the snippet is the first window chars with `matches: []` and `line: 1`.
 */
export function extractSnippet(
  body: string,
  bodyMatch: FuseResultMatch | undefined,
  query: string,
): SnippetResult {
  // Resolve the source-body match ranges (inclusive end → exclusive end).
  let ranges: Array<{ start: number; end: number }> = [];
  if (bodyMatch && bodyMatch.indices.length > 0) {
    ranges = bodyMatch.indices
      .map(([s, e]) => ({ start: s, end: e + 1 }))
      .sort((a, b) => a.start - b.start);
  } else {
    const idx = body.toLowerCase().indexOf(query.trim().toLowerCase());
    if (idx >= 0 && query.trim().length > 0) {
      ranges = [{ start: idx, end: idx + query.trim().length }];
    }
  }

  if (ranges.length === 0) {
    const snippet = body.slice(0, SNIPPET_RADIUS * 2);
    const section = nearestSection(body, 0);
    const result: SnippetResult = { snippet, matches: [], line: 1 };
    if (section !== undefined) result.section = section;
    return result;
  }

  const first = ranges[0];
  const line = countLines(body, first.start);
  const section = nearestSection(body, first.start);

  const windowStart = Math.max(0, first.start - SNIPPET_RADIUS);
  const windowEnd = Math.min(body.length, first.start + SNIPPET_RADIUS);
  const snippet = body.slice(windowStart, windowEnd);

  // Translate ranges into snippet-local coords, clamped to the window.
  const matches: MatchRange[] = [];
  for (const r of ranges) {
    const start = Math.max(r.start, windowStart);
    const end = Math.min(r.end, windowEnd);
    if (end <= start) continue;
    matches.push({ start: start - windowStart, end: end - windowStart });
  }

  const result: SnippetResult = { snippet, matches, line };
  if (section !== undefined) result.section = section;
  return result;
}

/** 1-based line number of the char at `offset` (count `\n` before it). */
function countLines(body: string, offset: number): number {
  let line = 1;
  const limit = Math.min(offset, body.length);
  for (let i = 0; i < limit; i++) {
    if (body[i] === '\n') line++;
  }
  return line;
}

/**
 * Nearest preceding markdown `#`-heading text at or before `offset`. Returns the
 * heading text (without the `#` markers) or `undefined` when none precedes.
 */
export function nearestSection(body: string, offset: number): string | undefined {
  const before = body.slice(0, offset);
  const headingRe = /^#{1,6}\s+(.+?)\s*$/gm;
  let match: RegExpExecArray | null;
  let last: string | undefined;
  while ((match = headingRe.exec(before)) !== null) {
    last = match[1].trim();
  }
  return last;
}
