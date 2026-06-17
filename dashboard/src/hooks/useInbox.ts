import { useCallback, useEffect, useState } from 'react';
import { useWebSocket, type WsMessage } from './useWebSocket';
import type { InboxCategory, InboxItem, InboxResult } from '../lib/inbox';

export type { InboxCategory, InboxItem, InboxResult } from '../lib/inbox';

interface UseInboxResult {
  items: InboxItem[];
  counts: Record<InboxCategory, number>;
  total: number;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

const EMPTY_COUNTS: Record<InboxCategory, number> = {
  review: 0,
  blocked: 0,
  question: 0,
  'plan-approval': 0,
};

/**
 * Fetch the cross-project "needs me" inbox (`GET /api/inbox`) and keep it live.
 *
 * Mirrors `useAssignmentEvents` (and the wider `useFetch` pattern): keyed on a
 * fetch counter, auto-refetching on the `assignment-updated` / `project-updated`
 * WebSocket broadcast so the view (and the nav badge) stay current the moment a
 * transition/comment/plan-approval lands anywhere — no new WS message type.
 *
 * Best-effort: the endpoint returns a stable `InboxResult` and never 500s under
 * normal operation; any fetch failure surfaces only inside the inbox view.
 *
 * The fetch URL is relative (`/api/inbox`) so it inherits the dashboard origin —
 * same as every other hook; the dev/preview server proxies it to the API.
 */
export function useInbox(): UseInboxResult {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [counts, setCounts] = useState<Record<InboxCategory, number>>(EMPTY_COUNTS);
  const [total, setTotal] = useState(0);
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

    fetch('/api/inbox')
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
  }, [fetchCount]);

  useWebSocket((message: WsMessage) => {
    if (message.type === 'assignment-updated' || message.type === 'project-updated') {
      refetch();
    }
  });

  return { items, counts, total, loading, error, refetch };
}
