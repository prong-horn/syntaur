import { useState, useEffect, useCallback } from 'react';
import { useWebSocket } from './useWebSocket';
import type {
  BundlesAggregateResponse,
  BundlesSingleScopeResponse,
} from '../types';

export function useAllBundles() {
  const [data, setData] = useState<BundlesAggregateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/bundles');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as BundlesAggregateResponse);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch bundles');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useWebSocket((msg) => {
    // Bundle endpoints reuse the existing `todos-updated` channel (see plan
    // Decision: no new WS message). Refetch on any non-project todos update.
    if (msg.type === 'todos-updated' && !msg.projectSlug) fetchData();
  });

  return { data, loading, error, refetch: fetchData };
}

export function useBundles(workspace: string) {
  const [data, setData] = useState<BundlesSingleScopeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/bundles/${encodeURIComponent(workspace)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as BundlesSingleScopeResponse);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch bundles');
    } finally {
      setLoading(false);
    }
  }, [workspace]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useWebSocket((msg) => {
    if (msg.type === 'todos-updated' && !msg.projectSlug) fetchData();
  });

  return { data, loading, error, refetch: fetchData };
}

export function useProjectBundles(projectId: string) {
  const [data, setData] = useState<BundlesSingleScopeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/bundles`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as BundlesSingleScopeResponse);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch bundles');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useWebSocket((msg) => {
    if (msg.type === 'todos-updated' && msg.projectSlug === projectId) fetchData();
  });

  return { data, loading, error, refetch: fetchData };
}
