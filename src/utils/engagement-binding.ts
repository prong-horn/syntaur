/**
 * The session→assignment binding read from the session's engagement edge.
 *
 * After the context.json demotion, the active (ticket, stage) is resolved
 * from the session's OPEN engagement — not the cwd scalar. This module is the
 * single seam that turns "the process I am running in" into "the ticket I am
 * working on", by resolving the caller's own session id (with provenance) and
 * reading its engagement row.
 *
 * Used by `resolveTicketTarget`'s injectable `resolveEngagement` option and
 * by the commands that need the binding directly.
 */

import { resolveOwnSessionId, type ResolvedSession } from './session-id.js';
import { initSessionDb } from '../dashboard/session-db.js';
import {
  getOpenEngagement,
  getLatestEngagement,
  switchEngagement,
  type EngagementRow,
} from '../db/engagement-db.js';
import { getCumulativeTokenSource } from '../db/engagement-tokens.js';

export interface EngagementBinding {
  ticketId: string | null;
  projectSlug: string | null;
  ticketSlug: string | null;
  stage: string;
}

export interface SessionEngagement {
  /** The caller's resolved session id + provenance (for assertMayMutate). */
  session: ResolvedSession;
  /** The session's open-engagement binding, or null when none is open. */
  open: EngagementBinding | null;
}

function rowToBinding(row: EngagementRow): EngagementBinding {
  return {
    ticketId: row.assignment_id,
    projectSlug: row.project_slug,
    ticketSlug: row.assignment_slug,
    stage: row.stage,
  };
}

/**
 * Resolve the caller's own session AND its open-engagement binding in one pass.
 * Returns null when the session id cannot be resolved at all. `open` is null
 * when the session has no open engagement. Mutating callers use `result.session`
 * to gate via `assertMayMutate` without resolving the session id twice.
 */
export async function resolveSessionEngagement(
  cwd: string,
): Promise<SessionEngagement | null> {
  const session = await resolveOwnSessionId({ cwd });
  if (!session) return null;
  initSessionDb(); // idempotent — engagement reads need the session-db handle
  const row = getOpenEngagement(session.id);
  return { session, open: row ? rowToBinding(row) : null };
}

/**
 * The open-engagement binding for the session resolved from `cwd`, or null.
 * This is the `resolveEngagement` seam passed into `resolveTicketTarget`.
 */
export async function resolveEngagementBinding(
  cwd: string,
): Promise<EngagementBinding | null> {
  const se = await resolveSessionEngagement(cwd);
  return se?.open ?? null;
}

/**
 * The session's MRU engagement binding (open-else-latest) for read-only
 * commands to *display* as a suggestion. Never used to implicitly resolve a
 * mutation target.
 */
export async function resolveLatestBinding(
  cwd: string,
): Promise<EngagementBinding | null> {
  const session = await resolveOwnSessionId({ cwd });
  if (!session) return null;
  initSessionDb(); // idempotent — engagement reads need the session-db handle
  const row = getLatestEngagement(session.id);
  return row ? rowToBinding(row) : null;
}

/**
 * The MRU engagement binding (open-else-latest) for an EXPLICITLY-supplied
 * session id — no own-session resolution. The SessionEnd cleanup path uses this:
 * by the time `recompute` runs, the hook's `session stop` has already CLOSED the
 * ending session's engagement, so we deliberately fall back to the latest closed
 * interval (`getLatestEngagement`, open-else-latest) to recover its binding.
 * Returns null when the session has no engagement row at all.
 */
export function latestBindingForSessionId(
  sessionId: string,
): EngagementBinding | null {
  initSessionDb(); // idempotent — engagement reads need the session-db handle
  const row = getLatestEngagement(sessionId);
  return row ? rowToBinding(row) : null;
}

export interface StageSwitchResult {
  /** The now-open engagement at the requested stage. */
  current: EngagementRow;
  /** The engagement that was open before the switch, or null when none was. */
  previous: EngagementRow | null;
  /** False when the session was already on (ticket, stage) — no switch made. */
  switched: boolean;
}

export interface SwitchSessionStageInput {
  sessionId: string;
  ticketId: string | null;
  projectSlug: string | null;
  ticketSlug: string | null;
  stage: string;
  /** Defaults to now. */
  startedAt?: string;
}

/**
 * Whether the open engagement already points at the input's target. Compares by
 * `assignment_id` when BOTH sides carry one (the authoritative identity), else by
 * `(project_slug, assignment_slug)`. This keeps a slug-only open interval from
 * being split just to backfill a now-resolved id (M1).
 */
function isSameTarget(open: EngagementRow, input: SwitchSessionStageInput): boolean {
  if (open.assignment_id && input.ticketId) {
    return open.assignment_id === input.ticketId;
  }
  return (
    open.project_slug === input.projectSlug &&
    open.assignment_slug === input.ticketSlug
  );
}

/**
 * Switch the session's open engagement to a new stage for the target ticket.
 *
 * - Captures the token snapshot via the async source BEFORE the synchronous
 *   `switchEngagement` (the #1 boundary; stage-fact-status-bridge Decision 10).
 * - **Same-(assignment,stage) skip:** if the open engagement is already there,
 *   makes no switch (no cost-window split / no spurious stage-open event) and
 *   returns `switched:false`. The stage-fact bridge still runs at the call site,
 *   so a half-applied fact still repairs (Decision 7/8).
 * - **id-else-slugs target match (M1):** the skip compares by `assignment_id`
 *   only when BOTH the open row and the input carry one; otherwise it falls back
 *   to `(project_slug, assignment_slug)`. So a slug-only interval (e.g. a freshly
 *   grabbed/tracked ticket whose `assignment_id` was not yet resolved) is NOT
 *   split merely to write the id when the first resolved-id stage assertion
 *   arrives for the SAME (ticket, stage) — splitting the cost window is worse
 *   than a null id, and per-assignment attribution falls back to slugs anyway.
 */
export async function switchSessionStage(
  input: SwitchSessionStageInput,
): Promise<StageSwitchResult> {
  initSessionDb();
  const open = getOpenEngagement(input.sessionId);
  if (open && open.stage === input.stage && isSameTarget(open, input)) {
    return { current: open, previous: open, switched: false };
  }
  const snapshot = await getCumulativeTokenSource()(input.sessionId);
  const current = switchEngagement({
    sessionId: input.sessionId,
    ticketId: input.ticketId,
    projectSlug: input.projectSlug,
    ticketSlug: input.ticketSlug,
    stage: input.stage,
    startedAt: input.startedAt ?? new Date().toISOString(),
    tokensSnapshot: snapshot,
  });
  return { current, previous: open, switched: true };
}
