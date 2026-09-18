import { useMemo } from 'react';
import {
  DEFAULT_SEARCH_CONFIG,
  normalizeSearchConfig,
  type SearchConfig,
} from '@shared/search-schema';
import { getDefaultResourceStore } from '../data/cache';
import { mutate } from '../data/mutate';
import { resources } from '../data/resources';
import { useResource } from '../data/useResource';

export interface SearchConfigResponse {
  search: SearchConfig;
  custom: boolean;
}

const DEFAULT: SearchConfigResponse = { search: DEFAULT_SEARCH_CONFIG, custom: false };

const searchConfigResource = () => resources.config<unknown>('search');

function normalize(data: unknown): SearchConfigResponse {
  if (!data || typeof data !== 'object') return DEFAULT;
  const raw = data as { search?: unknown; custom?: unknown };
  return { search: normalizeSearchConfig(raw.search), custom: raw.custom === true };
}

/** One-shot read through the shared cache; never rejects (defaults on failure). */
export function fetchSearchConfig(): Promise<SearchConfigResponse> {
  return getDefaultResourceStore()
    .read(searchConfigResource())
    .then(normalize, () => DEFAULT);
}

/**
 * Search config from the shared store. A Settings save writes the server's
 * response into the same cache entry, so every mounted consumer (the palette
 * included) re-renders without a reload; external config.md edits arrive via
 * the `config-updated` websocket invalidation.
 */
export function useSearchConfig(): SearchConfigResponse {
  const { data } = useResource(searchConfigResource());
  return useMemo(() => normalize(data), [data]);
}

export function invalidateSearchConfigCache(): void {
  getDefaultResourceStore().invalidate([{ tag: 'config', configKind: 'search' }]);
}

export async function saveSearchConfig(search: SearchConfig): Promise<SearchConfigResponse> {
  const response = await mutate<unknown>('POST', searchConfigResource().url, search);
  getDefaultResourceStore().write(searchConfigResource(), response);
  return normalize(response);
}

export async function resetSearchConfig(): Promise<SearchConfigResponse> {
  const response = await mutate<unknown>('DELETE', searchConfigResource().url);
  getDefaultResourceStore().write(searchConfigResource(), response);
  return normalize(response);
}
