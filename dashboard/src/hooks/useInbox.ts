import { useCallback, useEffect, useState } from 'react';
import { useWebSocket, type WsMessage } from './useWebSocket';
import type { InboxCategory, InboxItem, InboxResult } from '../lib/inbox';

export type { InboxCategory, InboxItem, InboxResult } from '../lib/inbox';

interface UseInboxOptions {
  project?: string | null;
  maxAgeDays?: number | null;
  includeSnoozed?: boolean;
}

interface UseInboxResult {
  items: InboxItem[];
  counts: Record<InboxCategory, number>;
  total: number;
  snoozedCount: number;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

const EMPTY_COUNTS: Record<InboxCategory, number> = {
  question: 0,
  review: 0,
  'plan-approval': 0,
};

/**
 * Fetch the cross-project "needs me" inbox (`GET /api/inbox`) and keep it live.
 */
export function useInbox(opts?: UseInboxOptions): UseInboxResult {
  const project = opts?.project ?? null;
  const maxAgeDays = opts?.maxAgeDays ?? null;
  const includeSnoozed = opts?.includeSnoozed ?? false;
  const [items, setItems] = useState<InboxItem[]>([]);
  const [counts, setCounts] = useState<Record<InboxCategory, number>>(EMPTY_COUNTS);
  const [total, setTotal] = useState(0);
  const [snoozedCount, setSnoozedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchCount, setFetchCount] = useState(0);

  const refetch = useCallback(() => {
    setFetchCount((count) => count + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (project) params.set('project', project);
    if (maxAgeDays !== null && maxAgeDays > 0) params.set('maxAgeDays', String(maxAgeDays));
    if (includeSnoozed) params.set('includeSnoozed', '1');
    const query = params.toString();
    const url = query ? `/api/inbox?${query}` : '/api/inbox';

    fetch(url)
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.error || `HTTP ${response.status}`);
        }
        return response.json() as Promise<InboxResult>;
      })
      .then((json) => {
        if (cancelled) return;
        setItems(Array.isArray(json.items) ? json.items : []);
        setCounts(json.counts ?? EMPTY_COUNTS);
        setTotal(typeof json.total === 'number' ? json.total : 0);
        setSnoozedCount(typeof json.snoozedCount === 'number' ? json.snoozedCount : 0);
        setLoading(false);
      })
      .catch((fetchError: Error) => {
        if (cancelled) return;
        setError(fetchError.message);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [fetchCount, project, maxAgeDays, includeSnoozed]);

  useWebSocket((message: WsMessage) => {
    if (message.type === 'ticket-updated' || message.type === 'project-updated') {
      refetch();
    }
  });

  return { items, counts, total, snoozedCount, loading, error, refetch };
}
