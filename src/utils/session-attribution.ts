/**
 * How a session row is attributed — the axis that separates real work from
 * spend records.
 *
 * The Agent Sessions list mixes three populations that look alike in a table but
 * are not the same kind of thing:
 *
 *  - **assigned** — a session bound to a Syntaur assignment.
 *  - **unassigned** — a real, tracked session with no assignment binding. Ad-hoc
 *    work: it has a transcript, a path, liveness, and supports resume/fork.
 *    This is the majority of real sessions.
 *  - **usage-only** — a synthetic row for a session id that appears in
 *    `usage_events` but has no `sessions` row at all. It exists only to surface
 *    spend; it has no transcript, no liveness, and no actions.
 *
 * Without a way to separate them the usage-only rows dominate (they outnumber
 * real sessions roughly 3:1), which buries exactly the ad-hoc sessions the page
 * is most useful for.
 *
 * Lives in `src/utils/` so the API route, the query layer, the dashboard hook,
 * and the page share one definition — registered explicitly as
 * `@shared/session-attribution` (there is no wildcard `@shared/*` mapping).
 */

export const SESSION_ATTRIBUTIONS = [
  'tracked',
  'all',
  'assigned',
  'unassigned',
  'usage-only',
] as const;

export type SessionAttribution = (typeof SESSION_ATTRIBUTIONS)[number];

/**
 * Real sessions only. This is the default because `usage-only` rows are spend
 * records rather than sessions — per-model spend has its own page (`/usage`),
 * and including them here means most of what you page through cannot be opened,
 * resumed, or acted on.
 */
export const DEFAULT_SESSION_ATTRIBUTION: SessionAttribution = 'tracked';

export function isSessionAttribution(value: unknown): value is SessionAttribution {
  return typeof value === 'string' && (SESSION_ATTRIBUTIONS as readonly string[]).includes(value);
}

/** Whether this view shows synthetic usage-only rows at all. */
export function includesUsageOnlyRows(attribution: SessionAttribution): boolean {
  return attribution === 'all' || attribution === 'usage-only';
}

/** Whether this view shows real `sessions` rows at all. */
export function includesTrackedRows(attribution: SessionAttribution): boolean {
  return attribution !== 'usage-only';
}

/** Human labels, keyed exhaustively so a new member cannot go unlabeled. */
export const ATTRIBUTION_LABELS: Record<SessionAttribution, string> = {
  tracked: 'Real sessions',
  all: 'Everything (incl. spend-only)',
  assigned: 'Assigned to an assignment',
  unassigned: 'Unassigned (ad-hoc)',
  'usage-only': 'Spend-only records',
};
