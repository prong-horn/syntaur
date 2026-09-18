import { useMemo } from 'react';
import { useResource } from '../data/useResource';
import { resources } from '../data/resources';
import type { InboxCategory, InboxItem } from '../lib/inbox';

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
const NO_ITEMS: InboxItem[] = [];

/**
 * The cross-project "needs me" inbox (`GET /api/inbox`), live via the shared
 * resource store. Callers with the same options (the page and the shell badge)
 * share one cache entry and one request.
 */
export function useInbox(opts?: UseInboxOptions): UseInboxResult {
  const { data, loading, error, refetch } = useResource(
    resources.inbox({
      project: opts?.project ?? null,
      maxAgeDays: opts?.maxAgeDays ?? null,
      includeSnoozed: opts?.includeSnoozed ?? false,
    }),
  );
  return useMemo(
    () => ({
      items: Array.isArray(data?.items) ? data.items : NO_ITEMS,
      counts: data?.counts ?? EMPTY_COUNTS,
      total: typeof data?.total === 'number' ? data.total : 0,
      snoozedCount: typeof data?.snoozedCount === 'number' ? data.snoozedCount : 0,
      loading,
      error: error ? error.message : null,
      refetch,
    }),
    [data, loading, error, refetch],
  );
}
