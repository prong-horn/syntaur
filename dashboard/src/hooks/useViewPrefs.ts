import { useEffect, useState } from 'react';
import {
  DEFAULT_VIEW_PREFS_FILE,
  mergeForScope,
  type ProjectViewPrefs,
  type ViewPrefs,
  type ViewPrefsFile,
  type ViewPrefsPatch,
} from '@shared/view-prefs-schema';

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

let cachedFile: ViewPrefsResponse | null = readLocalCache();
let fetchPromise: Promise<ViewPrefsResponse> | null = null;
const subscribers = new Set<(value: ViewPrefsResponse) => void>();

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

function notify(next: ViewPrefsResponse): void {
  cachedFile = next;
  writeLocalCache(next);
  for (const sub of subscribers) sub(next);
}

function normalize(data: unknown): ViewPrefsResponse {
  if (!data || typeof data !== 'object') return DEFAULT_RESPONSE;
  const raw = data as Partial<ViewPrefsResponse>;
  if (raw.version !== 1) return DEFAULT_RESPONSE;
  if (!raw.global || !raw.projects) return DEFAULT_RESPONSE;
  return {
    version: 1,
    global: raw.global,
    projects: raw.projects,
    custom: raw.custom === true,
  };
}

// Always hits the server (with in-flight dedupe). Cache is for first-paint
// only; server fetch reconciles whenever a consumer mounts.
export function fetchViewPrefs(): Promise<ViewPrefsResponse> {
  if (fetchPromise) return fetchPromise;

  fetchPromise = fetch('/api/view-prefs')
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((data) => {
      const normalized = normalize(data);
      notify(normalized);
      fetchPromise = null;
      return normalized;
    })
    .catch(() => {
      fetchPromise = null;
      return cachedFile ?? DEFAULT_RESPONSE;
    });

  return fetchPromise;
}

// Returns the effective merged ViewPrefs for a scope.
// scope === undefined → global. Density always comes from global.
export function useViewPrefs(scope?: string | null): ViewPrefs {
  const [file, setFile] = useState<ViewPrefsResponse>(() => cachedFile ?? DEFAULT_RESPONSE);

  useEffect(() => {
    let cancelled = false;
    fetchViewPrefs().then((next) => {
      if (!cancelled) setFile(next);
    });
    subscribers.add(setFile);
    return () => {
      cancelled = true;
      subscribers.delete(setFile);
    };
  }, []);

  return mergeForScope(file, scope ?? null);
}

// Returns the full file (for Settings page rendering).
export function useViewPrefsFile(): ViewPrefsResponse {
  const [file, setFile] = useState<ViewPrefsResponse>(() => cachedFile ?? DEFAULT_RESPONSE);

  useEffect(() => {
    let cancelled = false;
    fetchViewPrefs().then((next) => {
      if (!cancelled) setFile(next);
    });
    subscribers.add(setFile);
    return () => {
      cancelled = true;
      subscribers.delete(setFile);
    };
  }, []);

  return file;
}

async function postPatch(patch: ViewPrefsPatch): Promise<ViewPrefsResponse> {
  const res = await fetch('/api/view-prefs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error ?? 'Failed to save view-prefs');
  }
  const normalized = normalize(await res.json());
  notify(normalized);
  return normalized;
}

export function saveGlobalViewPrefs(patch: Partial<ViewPrefs>): Promise<ViewPrefsResponse> {
  return postPatch({ global: patch });
}

export function saveScopeViewPrefs(scope: string, patch: ProjectViewPrefs): Promise<ViewPrefsResponse> {
  return postPatch({ projects: { [scope]: patch } });
}

export async function resetViewPrefs(): Promise<ViewPrefsResponse> {
  const res = await fetch('/api/view-prefs', { method: 'DELETE' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const normalized = normalize(await res.json());
  notify(normalized);
  return normalized;
}

export function invalidateViewPrefsCache(): void {
  cachedFile = null;
  fetchPromise = null;
  clearLocalCache();
}
