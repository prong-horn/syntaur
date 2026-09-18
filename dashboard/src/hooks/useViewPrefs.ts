import { useEffect, useMemo } from 'react';
import {
  DEFAULT_VIEW_PREFS_FILE,
  mergeForScope,
  type ProjectViewPrefs,
  type ViewPrefs,
  type ViewPrefsFile,
  type ViewPrefsPatch,
} from '@shared/view-prefs-schema';
import { getDefaultResourceStore } from '../data/cache';
import { mutate } from '../data/mutate';
import { resources } from '../data/resources';
import { useResource } from '../data/useResource';

export interface ViewPrefsResponse extends ViewPrefsFile {
  custom: boolean;
}

const DEFAULT_RESPONSE: ViewPrefsResponse = {
  ...DEFAULT_VIEW_PREFS_FILE,
  custom: false,
};

// Cache key encodes the file version. If ViewPrefsFile.version ever changes,
// this key changes too — old caches are ignored instead of mis-parsed.
const CACHE_KEY = `view-prefs.cache.v${DEFAULT_VIEW_PREFS_FILE.version}`;

const viewPrefsResource = () => resources.viewPrefs<unknown>();

// Monotonic write sequence. Every POST / DELETE claims a fresh seq; its
// response is written into the shared cache only while it is still the latest
// write, so an out-of-order older write never overwrites a newer saved value.
// (A store `write` also supersedes any in-flight GET for the key.)
let latestSeq = 0;

function readLocalCache(): ViewPrefsResponse | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { version?: number };
    if (parsed.version !== DEFAULT_VIEW_PREFS_FILE.version) return null;
    return parsed as ViewPrefsResponse;
  } catch {
    return null;
  }
}

function writeLocalCache(value: ViewPrefsResponse): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(value));
  } catch {
    // localStorage may be unavailable in private mode or quota-full; skip.
  }
}

function clearLocalCache(): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.removeItem(CACHE_KEY);
  } catch {
    // ignore
  }
}

function normalize(data: unknown): ViewPrefsResponse {
  if (!data || typeof data !== 'object') return DEFAULT_RESPONSE;
  const raw = data as Partial<ViewPrefsResponse>;
  if (raw.version !== DEFAULT_VIEW_PREFS_FILE.version) return DEFAULT_RESPONSE;
  if (!raw.global || !raw.projects) return DEFAULT_RESPONSE;
  return {
    version: DEFAULT_VIEW_PREFS_FILE.version,
    global: raw.global,
    projects: raw.projects,
    custom: raw.custom === true,
  };
}

/**
 * Read view-prefs through the shared cache (first-paint localStorage copy is
 * only a fallback until the server answers). Never rejects.
 */
export function fetchViewPrefs(): Promise<ViewPrefsResponse> {
  return getDefaultResourceStore()
    .read(viewPrefsResource())
    .then(
      (data) => {
        const normalized = normalize(data);
        writeLocalCache(normalized);
        return normalized;
      },
      () => readLocalCache() ?? DEFAULT_RESPONSE,
    );
}

// Returns the full file (for Settings page rendering).
export function useViewPrefsFile(): ViewPrefsResponse {
  const { data } = useResource(viewPrefsResource());
  const file = useMemo(
    () => (data !== undefined ? normalize(data) : readLocalCache() ?? DEFAULT_RESPONSE),
    [data],
  );
  useEffect(() => {
    if (data !== undefined) writeLocalCache(file);
  }, [data, file]);
  return file;
}

// Returns the effective merged ViewPrefs for a scope.
// scope === undefined → global. Density always comes from global.
export function useViewPrefs(scope?: string | null): ViewPrefs {
  const file = useViewPrefsFile();
  return useMemo(() => mergeForScope(file, scope ?? null), [file, scope]);
}

async function writeViewPrefs(method: 'POST' | 'DELETE', patch?: ViewPrefsPatch): Promise<ViewPrefsResponse> {
  const seq = ++latestSeq;
  const response = await mutate<unknown>(method, viewPrefsResource().url, patch);
  const normalized = normalize(response);
  if (seq === latestSeq) {
    getDefaultResourceStore().write(viewPrefsResource(), response);
    writeLocalCache(normalized);
  }
  return normalized;
}

export function saveGlobalViewPrefs(patch: Partial<ViewPrefs>): Promise<ViewPrefsResponse> {
  return writeViewPrefs('POST', { global: patch });
}

export function saveScopeViewPrefs(scope: string, patch: ProjectViewPrefs): Promise<ViewPrefsResponse> {
  return writeViewPrefs('POST', { projects: { [scope]: patch } });
}

export function resetViewPrefs(): Promise<ViewPrefsResponse> {
  return writeViewPrefs('DELETE');
}

export function invalidateViewPrefsCache(): void {
  clearLocalCache();
  getDefaultResourceStore().invalidate([{ tag: 'view-prefs' }]);
}
