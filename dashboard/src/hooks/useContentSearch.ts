import { useEffect, useState } from 'react';
import { useResource } from '../data/useResource';
import { resources } from '../data/resources';
import type { ContentHit } from '../data/types';

export type { ContentHit, ContentMatchRange } from '../data/types';

interface ContentSearchState {
  hits: ContentHit[];
  loading: boolean;
  error: string | null;
}

const DEBOUNCE_MS = 200;
const MIN_QUERY_LENGTH = 2;
const NO_HITS: ContentHit[] = [];

/**
 * Debounced, `enabled`-gated content search over `/api/search`.
 *
 * The debounce chooses between a null resource (inert: no request, empty
 * hits) and the canonical search resource for the settled query. Each query is
 * its own cache key, so a slower response for an older query can never be
 * shown for a newer one, and results are never carried across queries.
 */
export function useContentSearch(query: string, enabled: boolean): ContentSearchState {
  const [debounced, setDebounced] = useState(query);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);

  const trimmed = debounced.trim();
  const active = enabled && trimmed.length >= MIN_QUERY_LENGTH;
  const { data, loading, error } = useResource(active ? resources.search(trimmed) : null);

  return {
    hits: data?.hits ?? NO_HITS,
    loading,
    error: error ? error.message : null,
  };
}
