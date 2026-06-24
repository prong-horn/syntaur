/**
 * The session→assignment binding read from the session's engagement edge.
 *
 * After the context.json demotion, the active (assignment, stage) is resolved
 * from the session's OPEN engagement — not the cwd scalar. This module is the
 * single seam that turns "the process I am running in" into "the assignment I am
 * working on", by resolving the caller's own session id (with provenance) and
 * reading its engagement row.
 *
 * Used by `resolveAssignmentTarget`'s injectable `resolveEngagement` option and
 * by the commands that need the binding directly.
 */

import { resolveOwnSessionId, type ResolvedSession } from './session-id.js';
import { initSessionDb } from '../dashboard/session-db.js';
import {
  getOpenEngagement,
  getLatestEngagement,
  type EngagementRow,
} from '../db/engagement-db.js';

export interface EngagementBinding {
  assignmentId: string | null;
  projectSlug: string | null;
  assignmentSlug: string | null;
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
    assignmentId: row.assignment_id,
    projectSlug: row.project_slug,
    assignmentSlug: row.assignment_slug,
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
 * This is the `resolveEngagement` seam passed into `resolveAssignmentTarget`.
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
