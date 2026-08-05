/**
 * The agent-sessions sort contract.
 *
 * Lives in `src/utils/` (not the SPA) because paging moved sorting server-side:
 * the API route, the SQL query layer, the dashboard hook, and the page all need
 * the same union, and root vitest can reach it here via the `@shared` alias —
 * the same arrangement `session-select.ts` uses.
 *
 * Note there is no wildcard `@shared/*` mapping; this module is registered
 * explicitly in `dashboard/vite.config.ts` and `dashboard/tsconfig.json`.
 * Server-side callers import it by relative NodeNext path instead.
 */

export const SESSION_SORTS = [
  'started_desc',
  'started_asc',
  'duration_desc',
  'duration_asc',
  'assignment_asc',
  'agent_asc',
  'spend_desc',
  'tokens_desc',
] as const;

export type SessionSort = (typeof SESSION_SORTS)[number];

export const DEFAULT_SESSION_SORT: SessionSort = 'started_desc';

/**
 * Narrow an untrusted string (a query param) to a SessionSort. The route uses
 * this to fall back to the default rather than passing arbitrary input into an
 * ORDER BY decision.
 */
export function isSessionSort(value: unknown): value is SessionSort {
  return typeof value === 'string' && (SESSION_SORTS as readonly string[]).includes(value);
}

/**
 * The two sorts that cannot be expressed as a SQL ORDER BY: per-session cost is
 * computed in JS (`priceForModel` in `db/usage-db.ts`) when a usage event
 * carries no stored `total_cost`, so there is no column to order on. These are
 * served by the ordered-id-list path in `listSessionsPage`.
 */
export type UsageSort = Extract<SessionSort, 'spend_desc' | 'tokens_desc'>;
/** Sorts routed through the JS merge path — see requiresMergeSort below. */
export type MergeSort = Extract<SessionSort, 'spend_desc' | 'tokens_desc' | 'duration_asc' | 'duration_desc'>;
/** The genuinely SQL-orderable sorts. */
export type SqlSort = Exclude<SessionSort, MergeSort>;

export function isUsageSort(sort: SessionSort): sort is UsageSort {
  return sort === 'spend_desc' || sort === 'tokens_desc';
}

/**
 * Sorts that SQL cannot express faithfully, so they take the JS merge path.
 *
 * - spend/tokens: cost is computed in JS (see UsageSort above).
 * - duration: a LIVE session's duration is `now - started`, which is what the
 *   client always showed. SQL would have to embed a clock in the ORDER BY;
 *   `COALESCE(ended, started)` instead makes live sessions zero-length and sorts
 *   them last — the opposite end from where users expect them.
 */
export function requiresMergeSort(sort: SessionSort): sort is MergeSort {
  return isUsageSort(sort) || sort === 'duration_asc' || sort === 'duration_desc';
}
