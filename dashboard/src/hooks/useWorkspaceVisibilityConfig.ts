import { useState, useEffect } from 'react';
import { normalizeHiddenList } from '@shared/workspace-visibility-schema';

export interface WorkspaceVisibilityConfigResponse {
  hidden: string[];
  custom: boolean;
}

export interface WorkspaceVisibilityConfigState extends WorkspaceVisibilityConfigResponse {
  /** True until the preference has been fetched at least once. */
  loading: boolean;
  /** True when the most recent load attempt failed (value falls back to default). */
  error: boolean;
  /** Re-fetch the preference from the server (clears the error/loading state). */
  reload: () => void;
}

interface FetchResult {
  value: WorkspaceVisibilityConfigResponse;
  ok: boolean;
}

const DEFAULT: WorkspaceVisibilityConfigResponse = { hidden: [], custom: false };

let cachedConfig: WorkspaceVisibilityConfigResponse | null = null;
let fetchPromise: Promise<FetchResult> | null = null;
let generation = 0;
const subscribers = new Set<(value: WorkspaceVisibilityConfigResponse) => void>();

function notify(next: WorkspaceVisibilityConfigResponse): void {
  cachedConfig = next;
  for (const sub of subscribers) sub(next);
}

function normalize(data: unknown): WorkspaceVisibilityConfigResponse {
  if (!data || typeof data !== 'object') return DEFAULT;
  const raw = data as { hidden?: unknown; custom?: unknown };
  return {
    hidden: normalizeHiddenList(raw.hidden),
    custom: raw.custom === true,
  };
}

/**
 * Fetch the preference, deduping concurrent callers via a shared in-flight
 * promise. Resolves `{ value, ok }`: on failure `ok` is false and `value` is
 * the safe default, but the cache is NOT populated so the next mount retries.
 * Callers that compute a new blocklist (the Settings toggles) must check `ok`
 * before allowing edits, or a failed load would let them overwrite the saved
 * list from the empty default.
 */
export function fetchWorkspaceVisibilityConfig(): Promise<FetchResult> {
  if (cachedConfig) return Promise.resolve({ value: cachedConfig, ok: true });
  if (fetchPromise) return fetchPromise;

  const gen = ++generation;
  fetchPromise = fetch('/api/config/workspace-visibility')
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((data): FetchResult => {
      fetchPromise = null;
      const normalized = normalize(data);
      if (gen !== generation) {
        return { value: cachedConfig ?? normalized, ok: true };
      }
      cachedConfig = normalized;
      return { value: normalized, ok: true };
    })
    .catch((): FetchResult => {
      fetchPromise = null;
      return { value: DEFAULT, ok: false };
    });

  return fetchPromise;
}

export function useWorkspaceVisibilityConfig(): WorkspaceVisibilityConfigState {
  const [config, setConfig] = useState<WorkspaceVisibilityConfigResponse>(
    () => cachedConfig ?? DEFAULT,
  );
  // Loading is true only until the first fetch resolves. If the value is
  // already cached (a prior mount loaded it), we're ready immediately.
  const [loading, setLoading] = useState<boolean>(() => cachedConfig === null);
  const [error, setError] = useState<boolean>(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(cachedConfig === null);
    fetchWorkspaceVisibilityConfig().then((res) => {
      if (cancelled) return;
      setConfig(res.value);
      setLoading(false);
      setError(!res.ok);
    });
    subscribers.add(setConfig);
    return () => {
      cancelled = true;
      subscribers.delete(setConfig);
    };
  }, [reloadToken]);

  function reload() {
    invalidateWorkspaceVisibilityConfigCache();
    setReloadToken((t) => t + 1);
  }

  return { ...config, loading, error, reload };
}

export function invalidateWorkspaceVisibilityConfigCache(): void {
  cachedConfig = null;
  fetchPromise = null;
  ++generation;
}

export async function saveWorkspaceVisibilityConfig(
  hidden: string[],
): Promise<WorkspaceVisibilityConfigResponse> {
  ++generation;
  const res = await fetch('/api/config/workspace-visibility', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hidden }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  const normalized = normalize(await res.json());
  notify(normalized);
  return normalized;
}

export async function resetWorkspaceVisibilityConfig(): Promise<WorkspaceVisibilityConfigResponse> {
  ++generation;
  const res = await fetch('/api/config/workspace-visibility', { method: 'DELETE' });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  const normalized = normalize(await res.json());
  notify(normalized);
  return normalized;
}
