/**
 * Thin emit layer over the events-db (`recordEvent`, the ONLY writer). It adds
 * two things the raw writer deliberately does not own:
 *
 *  1. A module-level `suppressEvents` switch so migrations (which replay
 *     statusHistory writes) do NOT fire live events.
 *  2. A `recordStatusEvent` wrapper carrying the `from !== to` self-guard (R5),
 *     so same-status writes (the recompute fact/attestation audit entry) emit
 *     no `status-change` event.
 *
 * Every emit ultimately goes through `recordEvent` (R3) — nothing here touches
 * the private `insertEvent`. `recordEvent` is best-effort and never throws, so
 * these helpers are side-effect-isolated: a logging failure never breaks the
 * caller's mutation.
 */

import { recordEvent, type RecordEventInput } from '../db/events-db.js';

/** When true, ALL emits from this module are no-ops (migrations set this). */
let suppressEvents = false;

export function setSuppressEvents(value: boolean): void {
  suppressEvents = value;
}

export function isSuppressingEvents(): boolean {
  return suppressEvents;
}

/**
 * Run `fn` with event emission suppressed, restoring the PRIOR value in a
 * `finally` (so nested suppression and re-entrancy are safe). Works for sync
 * and async `fn` — an async return value is awaited before restoring.
 */
export function withSuppressedEvents<T>(fn: () => T): T {
  const prior = suppressEvents;
  suppressEvents = true;
  try {
    const result = fn();
    if (result instanceof Promise) {
      // Restore only after the async work settles.
      return result.finally(() => {
        suppressEvents = prior;
      }) as unknown as T;
    }
    suppressEvents = prior;
    return result;
  } catch (e) {
    suppressEvents = prior;
    throw e;
  }
}

/**
 * The ONLY actor mapping (R7): sites pass their own already-resolved `by`; a
 * null/undefined `by` (e.g. the recompute system path) maps to `'system'`.
 */
export function resolveActor(by: string | null | undefined): string {
  return by ?? 'system';
}

export interface RecordStatusEventInput {
  assignmentId: string;
  projectSlug?: string | null;
  /** UTC ISO 8601; defaults to now inside recordEvent when omitted. */
  at?: string;
  /** Already-resolved actor string (pass through resolveActor at the site). */
  actor: string;
  from: string;
  to: string;
  /** The transition command/cause recorded on the statusHistory entry. */
  command: string;
}

/**
 * Emit a `status-change` event after a verified status write. Self-guards:
 *   - suppression on → no-op (migrations);
 *   - `from === to` → no event (R5; same-status audit entries are covered by
 *     the underlying fact-set/attestation event).
 * Delegates to `recordEvent` (best-effort, never throws).
 */
export function recordStatusEvent(input: RecordStatusEventInput): void {
  if (suppressEvents) return;
  if (input.from === input.to) return;
  recordEvent({
    assignmentId: input.assignmentId,
    projectSlug: input.projectSlug ?? null,
    type: 'status-change',
    actor: input.actor,
    at: input.at,
    details: { from: input.from, to: input.to, command: input.command },
  });
}

/**
 * Suppression-aware non-status emit. A thin wrapper over `recordEvent` that
 * gates on `suppressEvents` so migrations don't emit. Use for every non-status
 * tracked event (assignee-change, priority-change, archived, restored,
 * plan-approval, fact-set, fact-clear, attestation, comment-added,
 * comment-resolved). `recordEvent` is best-effort and never throws.
 */
export function emitEvent(input: RecordEventInput): void {
  if (suppressEvents) return;
  recordEvent(input);
}
