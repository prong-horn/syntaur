import { useMemo } from 'react';
import { DEFAULT_THEME_SLUG, isThemeSlug, type ThemeSlug } from '../themes';
import { getDefaultResourceStore } from '../data/cache';
import { mutate } from '../data/mutate';
import { resources } from '../data/resources';
import { useResource } from '../data/useResource';

export interface ThemeConfigResponse {
  preset: ThemeSlug;
  custom: boolean;
}

const DEFAULT_THEME_CONFIG: ThemeConfigResponse = {
  preset: DEFAULT_THEME_SLUG,
  custom: false,
};

const themeResource = () => resources.config<unknown>('theme');

function normalize(data: unknown): ThemeConfigResponse {
  if (!data || typeof data !== 'object') return DEFAULT_THEME_CONFIG;
  const raw = data as { preset?: unknown; custom?: unknown };
  const preset = isThemeSlug(raw.preset) ? raw.preset : DEFAULT_THEME_SLUG;
  return { preset, custom: raw.custom === true };
}

/** One-shot read through the shared cache; never rejects (defaults on failure). */
export function fetchThemeConfig(): Promise<ThemeConfigResponse> {
  return getDefaultResourceStore()
    .read(themeResource())
    .then(normalize, () => DEFAULT_THEME_CONFIG);
}

export function useThemeConfig(): ThemeConfigResponse {
  const { data } = useResource(themeResource());
  return useMemo(() => normalize(data), [data]);
}

export function invalidateThemeConfigCache(): void {
  getDefaultResourceStore().invalidate([{ tag: 'config', configKind: 'theme' }]);
}

export async function saveThemeConfig(preset: ThemeSlug): Promise<ThemeConfigResponse> {
  const response = await mutate<unknown>('POST', themeResource().url, { preset });
  getDefaultResourceStore().write(themeResource(), response);
  return normalize(response);
}

export async function resetThemeConfig(): Promise<ThemeConfigResponse> {
  const response = await mutate<unknown>('DELETE', themeResource().url);
  getDefaultResourceStore().write(themeResource(), response);
  return normalize(response);
}
