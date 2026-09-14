/**
 * Thin emit layer over the events-db (`recordEvent`, the ONLY writer). It adds
 * two things the raw writer deliberately does not own:
 *
 *  1. A module-level `suppressEvents` switch so migrations (which replay
 *     legacy frontmatter history writes) do NOT fire live events.
 *  2. Typed emit helpers for v2 lifecycle events (`moved`, `flagged`, …).
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

export interface EmitMovedInput {
  ticketId: string;
  projectSlug?: string | null;
  at?: string;
  from: string;
  to: string;
  verb: string;
  by: string;
  forced?: boolean;
  reason?: string;
}

export function emitMoved(input: EmitMovedInput): void {
  if (suppressEvents) return;
  if (input.from === input.to) return;
  recordEvent({
    ticketId: input.ticketId,
    projectSlug: input.projectSlug ?? null,
    type: 'moved',
    actor: input.by,
    at: input.at,
    details: {
      from: input.from,
      to: input.to,
      verb: input.verb,
      by: input.by,
      forced: input.forced ?? false,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    },
  });
}

export interface EmitFlaggedInput {
  ticketId: string;
  projectSlug?: string | null;
  at?: string;
  actor: string;
  flag: 'blocked' | 'parked';
  reason: string;
}

export function emitFlagged(input: EmitFlaggedInput): void {
  if (suppressEvents) return;
  recordEvent({
    ticketId: input.ticketId,
    projectSlug: input.projectSlug ?? null,
    type: 'flagged',
    actor: input.actor,
    at: input.at,
    details: { flag: input.flag, reason: input.reason },
  });
}

export interface EmitUnflaggedInput {
  ticketId: string;
  projectSlug?: string | null;
  at?: string;
  actor: string;
  flag: 'blocked' | 'parked';
}

export function emitUnflagged(input: EmitUnflaggedInput): void {
  if (suppressEvents) return;
  recordEvent({
    ticketId: input.ticketId,
    projectSlug: input.projectSlug ?? null,
    type: 'unflagged',
    actor: input.actor,
    at: input.at,
    details: { flag: input.flag },
  });
}

export interface EmitPlanApprovedInput {
  ticketId: string;
  projectSlug?: string | null;
  at?: string;
  actor: string;
  file: string;
  digest: string;
}

export function emitPlanApproved(input: EmitPlanApprovedInput): void {
  if (suppressEvents) return;
  recordEvent({
    ticketId: input.ticketId,
    projectSlug: input.projectSlug ?? null,
    type: 'plan-approved',
    actor: input.actor,
    at: input.at,
    details: { file: input.file, digest: input.digest },
  });
}

export interface EmitPlanVersionedInput {
  ticketId: string;
  projectSlug?: string | null;
  at?: string;
  actor: string;
  file: string;
}

export function emitPlanVersioned(input: EmitPlanVersionedInput): void {
  if (suppressEvents) return;
  recordEvent({
    ticketId: input.ticketId,
    projectSlug: input.projectSlug ?? null,
    type: 'plan-versioned',
    actor: input.actor,
    at: input.at,
    details: { file: input.file },
  });
}

export interface EmitCreatedInput {
  ticketId: string;
  projectSlug?: string | null;
  at?: string;
  actor: string;
}

export function emitCreated(input: EmitCreatedInput): void {
  if (suppressEvents) return;
  recordEvent({
    ticketId: input.ticketId,
    projectSlug: input.projectSlug ?? null,
    type: 'created',
    actor: input.actor,
    at: input.at,
    details: {},
  });
}

/**
 * Suppression-aware non-status emit. A thin wrapper over `recordEvent` that
 * gates on `suppressEvents` so migrations don't emit.
 */
export function emitEvent(input: RecordEventInput): void {
  if (suppressEvents) return;
  recordEvent(input);
}
