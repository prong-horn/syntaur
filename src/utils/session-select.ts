/**
 * Selection rules for the agent-sessions table.
 *
 * Lives in `src/utils/` (not the SPA) so it is reachable from root vitest via
 * the `@shared/session-select` alias — `dashboard/` has no test runner of its
 * own, and the select-all / header-checkbox math is exactly the kind of logic
 * that should not be verified by hand.
 */

/** The selection-relevant shape of a session row. */
export interface SelectableSession {
  sessionId: string;
  /** Synthetic usage-only rows have no DB row to act on, so they are never selectable. */
  usageOnly?: boolean;
}

/**
 * Ids eligible for bulk actions among `sessions` — everything except synthetic
 * usage-only rows, which exist purely to surface spend and have no `sessions`
 * row to delete or mutate.
 */
export function selectableSessionIds(sessions: readonly SelectableSession[]): string[] {
  return sessions.filter((s) => !s.usageOnly).map((s) => s.sessionId);
}

/** Header checkbox state for a list, given the currently-selected ids. */
export type HeaderCheckState = 'none' | 'some' | 'all';

/**
 * Header checkbox state derived from the *selectable* rows only, so a list that
 * is all usage-only rows reads `none` (and renders a disabled header box)
 * rather than appearing fully selected because zero-of-zero matched.
 */
export function headerCheckState(
  sessions: readonly SelectableSession[],
  selected: ReadonlySet<string>,
): HeaderCheckState {
  const eligible = selectableSessionIds(sessions);
  if (eligible.length === 0) return 'none';
  const hits = eligible.filter((id) => selected.has(id)).length;
  if (hits === 0) return 'none';
  return hits === eligible.length ? 'all' : 'some';
}
