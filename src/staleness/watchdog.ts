/**
 * Read-only staleness watchdog (pure core).
 *
 * Proactively surfaces assignments whose status has gone stale WITHOUT anyone
 * loading the dashboard, by emitting an audit event the first time an assignment
 * becomes stale and another when it recovers. Modeled on the idempotent
 * `gcExpiredLeases` sweep: running the same tick twice with the same inputs emits
 * nothing new — the `seen` set is the dedup cursor.
 *
 * STRICTLY read-only (decision D1): this never writes assignment frontmatter,
 * status, or statusHistory. Its ONLY side effect is the caller-supplied `emit`
 * (which the server points at the audit event log) — and that fires at most once
 * per stale episode, so repeated ticks don't spam.
 */

import type { StaleReason } from './classify.js';

export interface StaleCandidate {
  assignmentId: string;
  projectSlug: string | null;
  /** Empty → not currently stale. */
  reasons: StaleReason[];
}

export type WatchdogEventType = 'staleness-detected' | 'staleness-cleared';

export interface WatchdogEvent {
  assignmentId: string;
  projectSlug: string | null;
  type: WatchdogEventType;
  /** The reasons at detection time; empty for a clear event. */
  reasons: StaleReason[];
}

export interface WatchdogSummary {
  scanned: number;
  stale: number;
  newlyStale: number;
  cleared: number;
}

/**
 * One watchdog tick. Diffs the currently-stale set against `seen` (mutated in
 * place — it's the persistent cursor across ticks):
 *   - newly stale (stale now, not in seen) → emit `staleness-detected`, remember
 *   - recovered (in seen, not stale now)   → emit `staleness-cleared`, forget
 * Idempotent: a tick with no changes since the last emits nothing. Re-staleness
 * after a recovery re-emits (it left `seen`), which is intended.
 */
export function runStalenessWatchdogTick(
  candidates: StaleCandidate[],
  seen: Set<string>,
  emit: (event: WatchdogEvent) => void,
): WatchdogSummary {
  const staleNow = new Map<string, StaleCandidate>();
  for (const c of candidates) {
    if (c.reasons.length > 0) staleNow.set(c.assignmentId, c);
  }

  let newlyStale = 0;
  for (const [id, c] of staleNow) {
    if (!seen.has(id)) {
      seen.add(id);
      newlyStale++;
      emit({ assignmentId: id, projectSlug: c.projectSlug, type: 'staleness-detected', reasons: c.reasons });
    }
  }

  let cleared = 0;
  for (const id of [...seen]) {
    if (!staleNow.has(id)) {
      seen.delete(id);
      cleared++;
      // projectSlug isn't retained for recovered items; the consumer keys on
      // assignmentId. (Recovery events are advisory.)
      emit({ assignmentId: id, projectSlug: null, type: 'staleness-cleared', reasons: [] });
    }
  }

  return { scanned: candidates.length, stale: staleNow.size, newlyStale, cleared };
}
