import { useCallback, useEffect, useRef, useState } from 'react';
import { useWebSocket, type WsMessage } from './useWebSocket';

/**
 * One audit-timeline event for an assignment. Local to the SPA — the dashboard
 * is a separate TS project and cannot import backend `src/` types. Mirrors the
 * `EventRow` shape from `src/db/events-db.ts` with `details` already parsed from
 * its stored JSON string into an object (or null).
 */
export interface ActivityEvent {
  event_id: string;
  assignment_id: string;
  project_slug: string | null;
  /** UTC ISO 8601, newest-first. */
  at: string;
  actor: string;
  type: string;
  details: Record<string, unknown> | null;
  source_key: string | null;
}

interface EventsResponse {
  events: ActivityEvent[];
}

interface UseAssignmentEventsResult {
  events: ActivityEvent[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Fetch the per-assignment events endpoint. Mirrors the `useFetch` pattern in
 * `useProjects.ts`: keyed on the URL, auto-refetches on the `assignment-updated`
 * / `project-updated` WebSocket broadcast so the Activity tab live-updates the
 * same way the rest of the detail page does (no new WS message type).
 *
 * Best-effort by design — the endpoint never 500s (returns `{ events: [] }`),
 * and any fetch failure here is surfaced ONLY inside the Activity tab; it must
 * not break the rest of the assignment detail page.
 */
export function useAssignmentEvents(
  eventsUrl: string | null,
  enabled = true,
): UseAssignmentEventsResult {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchCount, setFetchCount] = useState(0);

  const activeUrl = enabled ? eventsUrl : null;

  const refetch = useCallback(() => {
    setFetchCount((count) => count + 1);
  }, []);

  // Drop stale events the moment the target URL changes, during render, so a
  // previous assignment's timeline is never painted on a new key.
  const lastUrlRef = useRef(activeUrl);
  if (lastUrlRef.current !== activeUrl) {
    lastUrlRef.current = activeUrl;
    setEvents([]);
    setError(null);
  }

  useEffect(() => {
    if (!activeUrl) {
      setLoading(false);
      setEvents([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(activeUrl)
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.error || `HTTP ${response.status}`);
        }
        return response.json() as Promise<EventsResponse>;
      })
      .then((json) => {
        if (!cancelled) {
          setEvents(Array.isArray(json.events) ? json.events : []);
          setLoading(false);
        }
      })
      .catch((fetchError: Error) => {
        if (!cancelled) {
          setError(fetchError.message);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeUrl, fetchCount]);

  useWebSocket((message: WsMessage) => {
    if (!activeUrl) return;
    if (message.type === 'assignment-updated' || message.type === 'project-updated') {
      refetch();
    }
  });

  return { events, loading, error, refetch };
}
