/**
 * Archived visibility for the Agent Sessions list.
 *
 * Archiving is the non-destructive counterpart to deleting a session: the row,
 * its summary, and its engagement edges all survive, but the session drops out
 * of the default list. It is orthogonal to `status` — archiving a LIVE session
 * does not end it, and liveness reconciliation still sweeps it.
 *
 * Three states rather than a boolean because "show me only the archived ones"
 * is the natural way to find something you put away, and it is the only
 * practical route to unarchiving once a session is hidden.
 *
 * Lives in `src/utils/` so the API route, the query layer, the dashboard hook,
 * and the page share one definition — registered explicitly as
 * `@shared/session-archived` (there is no wildcard `@shared/*` mapping), the
 * same arrangement `session-sort.ts` and `session-attribution.ts` use.
 */

export const ARCHIVED_FILTERS = ['hide', 'show', 'only'] as const;

export type ArchivedFilter = (typeof ARCHIVED_FILTERS)[number];

/**
 * Hidden by default. Archiving exists precisely so these rows stop competing
 * for attention, so the default list must not show them.
 *
 * This default is also what keeps the Overview `agent-sessions` widget correct
 * without any widget-side code: it never opts in, so it never shows archived
 * sessions.
 */
export const DEFAULT_ARCHIVED_FILTER: ArchivedFilter = 'hide';

/**
 * Narrow an untrusted string (a query param) to an ArchivedFilter. The route
 * uses this to fall back to the default rather than passing arbitrary input
 * into a WHERE-clause decision.
 */
export function isArchivedFilter(value: unknown): value is ArchivedFilter {
  return typeof value === 'string' && (ARCHIVED_FILTERS as readonly string[]).includes(value);
}

/**
 * Display labels for the filter control. Kept beside the union so a new state
 * cannot be added without a label, mirroring ATTRIBUTION_LABELS.
 */
export const ARCHIVED_LABELS: Record<ArchivedFilter, string> = {
  hide: 'Archived hidden',
  show: 'Archived shown',
  only: 'Archived only',
};
