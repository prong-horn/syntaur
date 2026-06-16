import { useState, useEffect } from 'react';
import {
  DEFAULT_SEARCH_CONFIG,
  normalizeSearchConfig,
  type SearchConfig,
} from '@shared/search-schema';

export interface SearchConfigResponse {
  search: SearchConfig;
  custom: boolean;
}

const DEFAULT: SearchConfigResponse = { search: DEFAULT_SEARCH_CONFIG, custom: false };

// Module-level cache + subscriber set. `saveSearchConfig`/`resetSearchConfig`
// call notify(), which re-renders every useSearchConfig() subscriber — this is how
// an in-app Settings save propagates live to the permanently-mounted palette
// (HotkeyProvider/CommandPalette) without a page reload. Only EXTERNAL edits to
// config.md require a reload (parity with useTerminalConfig).
let cachedConfig: SearchConfigResponse | null = null;
let fetchPromise: Promise<SearchConfigResponse> | null = null;
let generation = 0;
const subscribers = new Set<(value: SearchConfigResponse) => void>();

function notify(next: SearchConfigResponse): void {
  cachedConfig = next;
  for (const sub of subscribers) sub(next);
}

function normalize(data: unknown): SearchConfigResponse {
  if (!data || typeof data !== 'object') return DEFAULT;
  const raw = data as { search?: unknown; custom?: unknown };
  return { search: normalizeSearchConfig(raw.search), custom: raw.custom === true };
}

export function fetchSearchConfig(): Promise<SearchConfigResponse> {
  if (cachedConfig) return Promise.resolve(cachedConfig);
  if (fetchPromise) return fetchPromise;

  const gen = ++generation;
  fetchPromise = fetch('/api/config/search')
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((data) => {
      fetchPromise = null;
      const normalized = normalize(data);
      if (gen !== generation) {
        return cachedConfig ?? normalized;
      }
      cachedConfig = normalized;
      return normalized;
    })
    .catch(() => {
      fetchPromise = null;
      return DEFAULT;
    });

  return fetchPromise;
}

export function useSearchConfig(): SearchConfigResponse {
  const [config, setConfig] = useState<SearchConfigResponse>(
    () => cachedConfig ?? DEFAULT,
  );

  useEffect(() => {
    let cancelled = false;
    fetchSearchConfig().then((next) => {
      if (!cancelled) setConfig(next);
    });
    subscribers.add(setConfig);
    return () => {
      cancelled = true;
      subscribers.delete(setConfig);
    };
  }, []);

  return config;
}

export function invalidateSearchConfigCache(): void {
  cachedConfig = null;
  fetchPromise = null;
  ++generation;
}

export async function saveSearchConfig(
  search: SearchConfig,
): Promise<SearchConfigResponse> {
  ++generation;
  const res = await fetch('/api/config/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(search),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: string; errors?: string[] }
      | null;
    throw new Error(body?.errors?.join('; ') ?? body?.error ?? `HTTP ${res.status}`);
  }
  const normalized = normalize(await res.json());
  notify(normalized);
  return normalized;
}

export async function resetSearchConfig(): Promise<SearchConfigResponse> {
  ++generation;
  const res = await fetch('/api/config/search', { method: 'DELETE' });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  const normalized = normalize(await res.json());
  notify(normalized);
  return normalized;
}
