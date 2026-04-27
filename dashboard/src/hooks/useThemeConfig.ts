import { useState, useEffect } from 'react';
import { DEFAULT_THEME_SLUG, isThemeSlug, type ThemeSlug } from '../themes';

export interface ThemeConfigResponse {
  preset: ThemeSlug;
  custom: boolean;
}

const DEFAULT_THEME_CONFIG: ThemeConfigResponse = {
  preset: DEFAULT_THEME_SLUG,
  custom: false,
};

let cachedConfig: ThemeConfigResponse | null = null;
let fetchPromise: Promise<ThemeConfigResponse> | null = null;

function normalize(data: unknown): ThemeConfigResponse {
  if (!data || typeof data !== 'object') return DEFAULT_THEME_CONFIG;
  const raw = data as { preset?: unknown; custom?: unknown };
  const preset = isThemeSlug(raw.preset) ? raw.preset : DEFAULT_THEME_SLUG;
  return { preset, custom: raw.custom === true };
}

export function fetchThemeConfig(): Promise<ThemeConfigResponse> {
  if (cachedConfig) return Promise.resolve(cachedConfig);
  if (fetchPromise) return fetchPromise;

  fetchPromise = fetch('/api/config/theme')
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((data) => {
      const normalized = normalize(data);
      cachedConfig = normalized;
      fetchPromise = null;
      return normalized;
    })
    .catch(() => {
      fetchPromise = null;
      return DEFAULT_THEME_CONFIG;
    });

  return fetchPromise;
}

export function useThemeConfig(): ThemeConfigResponse {
  const [config, setConfig] = useState<ThemeConfigResponse>(
    () => cachedConfig ?? DEFAULT_THEME_CONFIG,
  );

  useEffect(() => {
    fetchThemeConfig().then(setConfig);
  }, []);

  return config;
}

export function invalidateThemeConfigCache(): void {
  cachedConfig = null;
  fetchPromise = null;
}

export async function saveThemeConfig(preset: ThemeSlug): Promise<ThemeConfigResponse> {
  const res = await fetch('/api/config/theme', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preset }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error ?? 'Failed to save theme');
  }
  const normalized = normalize(await res.json());
  cachedConfig = normalized;
  return normalized;
}

export async function resetThemeConfig(): Promise<ThemeConfigResponse> {
  const res = await fetch('/api/config/theme', { method: 'DELETE' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const normalized = normalize(await res.json());
  cachedConfig = normalized;
  return normalized;
}
