import { useEffect, useState } from 'react';

/**
 * One ranked content-search hit returned by `GET /api/search` (`{ hits: [...] }`).
 *
 * MIRRORS the backend `SearchHit` in `src/search/types.ts`. The dashboard is a
 * separate TS project and cannot import backend types, so this is a local copy —
 * keep it in sync. `route` is the UNPREFIXED app path; the palette mapper
 * (`contentHitsToEntries`) prepends the per-hit `/w/<workspace>` prefix where one
 * exists. `snippet` is NEUTRAL text and `matches` are snippet-local char offsets;
 * the renderer escapes the text and wraps the ranges in `<mark>` (HTML-safe).
 */
export interface ContentMatchRange {
  start: number;
  end: number;
}

export interface ContentHit {
  path: string;
  projectSlug: string | null;
  projectWorkspace: string | null;
  assignmentSlug: string | null;
  assignmentId: string | null;
  standalone: boolean;
  itemSlug?: string;
  fileKind:
    | 'assignment'
    | 'plan'
    | 'progress'
    | 'comments'
    | 'handoff'
    | 'decision-record'
    | 'scratchpad'
    | 'memory'
    | 'resource';
  title: string;
  score: number;
  snippet: string;
  matches: ContentMatchRange[];
  line: number;
  section?: string;
  /** Precomputed UNPREFIXED app route (see backend `routeForHit`). */
  route: string;
}

interface ContentSearchState {
  hits: ContentHit[];
  loading: boolean;
  error: string | null;
}

const DEBOUNCE_MS = 200;
const MIN_QUERY_LENGTH = 2;

/**
 * Debounced, `enabled`-gated content search over `/api/search`.
 *
 * Only fires a request when `enabled` is true AND the debounced query is at
 * least {@link MIN_QUERY_LENGTH} chars — otherwise returns empty hits and makes
 * no request (so the command palette doesn't hammer the index on every keystroke
 * or while closed). Mirrors the `enabled`-gating of `useFetch` in
 * `useProjects.ts`, with a leading debounce on the query.
 */
export function useContentSearch(query: string, enabled: boolean): ContentSearchState {
  const [debounced, setDebounced] = useState(query);
  const [hits, setHits] = useState<ContentHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounce the raw query so each keystroke doesn't fire a fetch.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);

  const trimmed = debounced.trim();
  const active = enabled && trimmed.length >= MIN_QUERY_LENGTH;

  useEffect(() => {
    if (!active) {
      // Inert: no request, clear any stale results.
      setHits([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/search?q=${encodeURIComponent(trimmed)}`)
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.error || `HTTP ${response.status}`);
        }
        return response.json() as Promise<{ hits: ContentHit[] }>;
      })
      .then((json) => {
        if (!cancelled) {
          setHits(json.hits ?? []);
          setLoading(false);
        }
      })
      .catch((fetchError: Error) => {
        if (!cancelled) {
          setError(fetchError.message);
          setHits([]);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [active, trimmed]);

  return { hits, loading, error };
}
