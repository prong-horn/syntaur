import { useResource } from '../data/useResource';
import { resources } from '../data/resources';
import type { ActivityEvent } from '../data/types';

export type { ActivityEvent } from '../data/types';

interface UseTicketEventsResult {
  events: ActivityEvent[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

const NO_EVENTS: ActivityEvent[] = [];

/**
 * The per-ticket audit timeline (`GET /api/tickets/:id/events`) through the
 * shared resource store. It refreshes on this ticket's `ticket-updated`
 * invalidation; another ticket's timeline is never shown for this id.
 *
 * Best-effort by design — the endpoint never 500s (returns `{ events: [] }`),
 * and any failure here is surfaced ONLY inside the Activity tab; it must not
 * break the rest of the ticket detail page.
 */
export function useTicketEvents(
  ticketId: string | null | undefined,
  enabled = true,
): UseTicketEventsResult {
  const { data, loading, error, refetch } = useResource(
    enabled && ticketId ? resources.ticketEvents(ticketId) : null,
  );
  return {
    events: Array.isArray(data?.events) ? data.events : NO_EVENTS,
    loading,
    error: error ? error.message : null,
    refetch,
  };
}
