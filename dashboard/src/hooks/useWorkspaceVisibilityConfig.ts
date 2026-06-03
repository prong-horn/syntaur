import { useState, useEffect } from 'react';
import { normalizeHiddenList } from '@shared/workspace-visibility-schema';

export interface WorkspaceVisibilityConfigResponse {
  hidden: string[];
  custom: boolean;
}

export interface WorkspaceVisibilityConfigState extends WorkspaceVisibilityConfigResponse {
  /** False until the preference has been fetched at least once. */
  loading: boolean;
}

const DEFAULT: WorkspaceVisibilityConfigResponse = { hidden: [], custom: false };

let cachedConfig: WorkspaceVisibilityConfigResponse | null = null;
let fetchPromise: Promise<WorkspaceVisibilityConfigResponse> | null = null;
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

export function fetchWorkspaceVisibilityConfig(): Promise<WorkspaceVisibilityConfigResponse> {
  if (cachedConfig) return Promise.resolve(cachedConfig);
  if (fetchPromise) return fetchPromise;

  const gen = ++generation;
  fetchPromise = fetch('/api/config/workspace-visibility')
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

export function useWorkspaceVisibilityConfig(): WorkspaceVisibilityConfigState {
  const [config, setConfig] = useState<WorkspaceVisibilityConfigResponse>(
    () => cachedConfig ?? DEFAULT,
  );
  // Loading is true only until the first fetch resolves. If the value is
  // already cached (a prior mount loaded it), we're ready immediately.
  const [loading, setLoading] = useState<boolean>(() => cachedConfig === null);

  useEffect(() => {
    let cancelled = false;
    fetchWorkspaceVisibilityConfig().then((next) => {
      if (!cancelled) {
        setConfig(next);
        setLoading(false);
      }
    });
    subscribers.add(setConfig);
    return () => {
      cancelled = true;
      subscribers.delete(setConfig);
    };
  }, []);

  return { ...config, loading };
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
