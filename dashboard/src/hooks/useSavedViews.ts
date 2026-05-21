import { useEffect, useState } from 'react';
import {
  DEFAULT_SAVED_VIEWS_FILE,
  type DashboardSlot,
  type SavedView,
  type SavedViewConfig,
  type SavedViewsFile,
} from '@shared/saved-views-schema';

// Cache key encodes the file version. If SavedViewsFile.version ever changes,
// this key changes too — old caches are ignored instead of mis-parsed.
const CACHE_KEY = `syntaur.savedViews.cache.v${DEFAULT_SAVED_VIEWS_FILE.version}`;

let cachedFile: SavedViewsFile | null = readLocalCache();
let fetchPromise: Promise<SavedViewsFile> | null = null;
let lastError: Error | null = null;
const subscribers = new Set<(value: SavedViewsFile) => void>();
const errorSubscribers = new Set<(err: Error | null) => void>();

// Monotonic request sequence. Every fetch / write claims a fresh seq before
// issuing; on completion the response only `notify()`s if its seq is still
// latest. Prevents a stale in-flight GET or an out-of-order POST from
// overwriting a newer just-saved value. (Mirrors useViewPrefs pattern.)
let latestSeq = 0;
function claimSeq(): number {
  return ++latestSeq;
}
function isLatest(seq: number): boolean {
  return seq === latestSeq;
}

function readLocalCache(): SavedViewsFile | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { version?: number };
    if (parsed.version !== DEFAULT_SAVED_VIEWS_FILE.version) return null;
    return parsed as SavedViewsFile;
  } catch {
    return null;
  }
}

function writeLocalCache(value: SavedViewsFile): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(value));
  } catch {
    // localStorage may be unavailable in private mode or quota-full; skip.
  }
}

function notify(next: SavedViewsFile): void {
  cachedFile = next;
  lastError = null;
  writeLocalCache(next);
  for (const sub of subscribers) sub(next);
  for (const sub of errorSubscribers) sub(null);
}

function notifyError(err: Error): void {
  lastError = err;
  for (const sub of errorSubscribers) sub(err);
}

function normalize(data: unknown): SavedViewsFile {
  if (!data || typeof data !== 'object') return DEFAULT_SAVED_VIEWS_FILE;
  const raw = data as Partial<SavedViewsFile>;
  if (raw.version !== DEFAULT_SAVED_VIEWS_FILE.version) return DEFAULT_SAVED_VIEWS_FILE;
  if (!Array.isArray(raw.views) || !raw.dashboard) return DEFAULT_SAVED_VIEWS_FILE;
  return raw as SavedViewsFile;
}

// Always hits the server (with in-flight dedupe). Cache is for first-paint
// only; server fetch reconciles whenever a consumer mounts.
export function fetchSavedViews(): Promise<SavedViewsFile> {
  if (fetchPromise) return fetchPromise;

  const seq = claimSeq();
  fetchPromise = fetch('/api/saved-views')
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((data) => {
      const normalized = normalize(data);
      if (isLatest(seq)) notify(normalized);
      fetchPromise = null;
      return cachedFile ?? normalized;
    })
    .catch((err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err));
      if (isLatest(seq)) notifyError(e);
      fetchPromise = null;
      return cachedFile ?? DEFAULT_SAVED_VIEWS_FILE;
    });

  return fetchPromise;
}

export interface SavedViewsFileState {
  file: SavedViewsFile;
  loading: boolean;
  error: Error | null;
  refetch(): void;
}

export function useSavedViewsFile(): SavedViewsFileState {
  const [file, setFile] = useState<SavedViewsFile>(() => cachedFile ?? DEFAULT_SAVED_VIEWS_FILE);
  const [loading, setLoading] = useState<boolean>(() => cachedFile === null);
  const [error, setError] = useState<Error | null>(() => lastError);

  useEffect(() => {
    let cancelled = false;
    if (cachedFile === null) setLoading(true);
    fetchSavedViews().then((next) => {
      if (!cancelled) {
        setFile(next);
        setLoading(false);
      }
    });
    const onFile = (next: SavedViewsFile) => {
      if (!cancelled) {
        setFile(next);
        setLoading(false);
        setError(null);
      }
    };
    const onError = (err: Error | null) => {
      if (!cancelled) {
        setError(err);
        setLoading(false);
      }
    };
    subscribers.add(onFile);
    errorSubscribers.add(onError);
    return () => {
      cancelled = true;
      subscribers.delete(onFile);
      errorSubscribers.delete(onError);
    };
  }, []);

  const refetch = () => {
    fetchPromise = null;
    setLoading(true);
    setError(null);
    fetchSavedViews();
  };

  return { file, loading, error, refetch };
}

export function useSavedViews(): { views: SavedView[]; loading: boolean } {
  const { file, loading } = useSavedViewsFile();
  return { views: file.views, loading };
}

export function useDashboardLayout(): { layout: SavedViewsFile['dashboard']; loading: boolean } {
  const { file, loading } = useSavedViewsFile();
  return { layout: file.dashboard, loading };
}

export interface SavedViewState {
  view: SavedView | null;
  loading: boolean;
  error: Error | null;
  refetch(): void;
}

export function useSavedView(id: string | null | undefined): SavedViewState {
  const { file, loading, error, refetch } = useSavedViewsFile();
  if (!id) return { view: null, loading: false, error: null, refetch };
  const view = file.views.find((v) => v.id === id) ?? null;
  return { view, loading, error, refetch };
}

async function postJson(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<SavedViewsFile> {
  const seq = claimSeq();
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  const normalized = normalize(await res.json());
  if (isLatest(seq)) notify(normalized);
  return normalized;
}

export function createSavedView(input: {
  name: string;
  workspace: string | null;
  config: SavedViewConfig;
}): Promise<SavedViewsFile> {
  return postJson('POST', '/api/saved-views', input);
}

export function updateSavedView(
  id: string,
  patch: { name?: string; workspace?: string | null; config?: SavedViewConfig },
): Promise<SavedViewsFile> {
  return postJson('PATCH', `/api/saved-views/${encodeURIComponent(id)}`, patch);
}

export function deleteSavedView(id: string): Promise<SavedViewsFile> {
  return postJson('DELETE', `/api/saved-views/${encodeURIComponent(id)}`);
}

export function setDashboardLayout(slots: DashboardSlot[]): Promise<SavedViewsFile> {
  return postJson('PUT', '/api/dashboard', { slots });
}

export function invalidateSavedViewsCache(): void {
  cachedFile = null;
  fetchPromise = null;
  lastError = null;
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.removeItem(CACHE_KEY);
    } catch {
      // ignore
    }
  }
}
