/**
 * Engagement runtime operations — the session↔assignment edge API.
 *
 * All ops run on the **session-db connection** (`getSessionDb()`), the same
 * handle `usage/session-join.ts` uses, so a close+open switch is a single
 * synchronous atomic transaction (decision-record.md Decision 4). The DDL +
 * schema-version constant live in `engagement-schema.ts` (zero-import) to avoid a
 * `session-db ↔ engagement-db` import cycle (Decision 10).
 *
 * Invariant: at most one OPEN engagement (`ended_at IS NULL`) per session,
 * enforced by the `one_active_per_session` partial unique index.
 *
 * Closing is **compare-and-close by `id` + `started_at`** so a racing liveness
 * GC can never clobber an interval that was already closed and re-opened
 * (Decision 4 / Decision 8). Token snapshots are captured by the caller (async,
 * before the transaction) and passed in (Decision 2 / Decision 11).
 */

import { getSessionDb } from '../dashboard/session-db.js';
import {
  serializeSnapshot,
  type TokenSnapshot,
} from './engagement-tokens.js';

export interface EngagementRow {
  id: number;
  session_id: string;
  assignment_id: string | null;
  project_slug: string | null;
  assignment_slug: string | null;
  stage: string;
  started_at: string;
  ended_at: string | null;
  tokens_at_open: string | null;
  tokens_at_close: string | null;
  close_reason: string | null;
}

export interface OpenEngagementInput {
  sessionId: string;
  assignmentId?: string | null;
  projectSlug?: string | null;
  assignmentSlug?: string | null;
  stage?: string;
  startedAt: string;
  tokensAtOpen?: TokenSnapshot | null;
}

const DEFAULT_STAGE = 'implement';

/** The session's current open engagement, or null. */
export function getOpenEngagement(sessionId: string): EngagementRow | null {
  const row = getSessionDb()
    .prepare(
      'SELECT * FROM engagement WHERE session_id = ? AND ended_at IS NULL LIMIT 1',
    )
    .get(sessionId) as EngagementRow | undefined;
  return row ?? null;
}

/**
 * The session's CHOSEN engagement — the open one, else the latest by
 * `started_at`. Used to recover a session's binding (e.g. to reopen an
 * engagement when a stopped session is revived with no fresh binding).
 */
export function getLatestEngagement(sessionId: string): EngagementRow | null {
  const row = getSessionDb()
    .prepare(
      `SELECT * FROM engagement WHERE session_id = ?
        ORDER BY (ended_at IS NULL) DESC, started_at DESC, id DESC
        LIMIT 1`,
    )
    .get(sessionId) as EngagementRow | undefined;
  return row ?? null;
}

/**
 * All engagement rows for an assignment, oldest first. Powers the assignment
 * details "Session Activity" attribution view — the full per-session stage
 * history, distinct from the single *chosen* engagement the agent-sessions
 * endpoint returns. Ordered by `started_at` (then `id` to tie-break rows that
 * share a timestamp); the `idx_engagement_assignment` index covers the filter.
 */
export function getEngagementsByAssignmentId(assignmentId: string): EngagementRow[] {
  return getSessionDb()
    .prepare(
      `SELECT * FROM engagement WHERE assignment_id = ?
        ORDER BY started_at ASC, id ASC`,
    )
    .all(assignmentId) as EngagementRow[];
}

/** True if the session has any engagement row at all (open or closed). */
export function hasAnyEngagement(sessionId: string): boolean {
  return (
    getSessionDb()
      .prepare('SELECT 1 FROM engagement WHERE session_id = ? LIMIT 1')
      .get(sessionId) !== undefined
  );
}

export interface ClosedEngagementInput {
  sessionId: string;
  assignmentId?: string | null;
  projectSlug?: string | null;
  assignmentSlug?: string | null;
  stage?: string;
  startedAt: string;
  endedAt: string;
  closeReason: string;
}

/**
 * Insert an already-CLOSED engagement (e.g. a terminal session first observed
 * post-migration: preserve its binding as a closed interval so historical
 * attribution survives, without occupying the one-open slot). No token
 * snapshots — there is no live cumulative for an already-ended session.
 */
export function insertClosedEngagement(input: ClosedEngagementInput): EngagementRow {
  const res = getSessionDb()
    .prepare(
      `INSERT INTO engagement
         (session_id, assignment_id, project_slug, assignment_slug, stage, started_at, ended_at, close_reason)
       VALUES (@sessionId, @assignmentId, @projectSlug, @assignmentSlug, @stage, @startedAt, @endedAt, @closeReason)`,
    )
    .run({
      sessionId: input.sessionId,
      assignmentId: input.assignmentId ?? null,
      projectSlug: input.projectSlug ?? null,
      assignmentSlug: input.assignmentSlug ?? null,
      stage: input.stage ?? DEFAULT_STAGE,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      closeReason: input.closeReason,
    });
  return getEngagementById(Number(res.lastInsertRowid));
}

function getEngagementById(id: number): EngagementRow {
  const row = getSessionDb()
    .prepare('SELECT * FROM engagement WHERE id = ?')
    .get(id) as EngagementRow | undefined;
  if (!row) throw new Error(`engagement ${id} not found after insert`);
  return row;
}

/**
 * INSERT a new open engagement. Throws on the unique index if the session
 * already has an open engagement — callers that want idempotency use
 * `ensureOpenEngagement`, and switches use `switchEngagement`.
 */
export function openEngagement(input: OpenEngagementInput): EngagementRow {
  const res = getSessionDb()
    .prepare(
      `INSERT INTO engagement
         (session_id, assignment_id, project_slug, assignment_slug, stage, started_at, tokens_at_open)
       VALUES (@sessionId, @assignmentId, @projectSlug, @assignmentSlug, @stage, @startedAt, @tokensAtOpen)`,
    )
    .run({
      sessionId: input.sessionId,
      assignmentId: input.assignmentId ?? null,
      projectSlug: input.projectSlug ?? null,
      assignmentSlug: input.assignmentSlug ?? null,
      stage: input.stage ?? DEFAULT_STAGE,
      startedAt: input.startedAt,
      tokensAtOpen: serializeSnapshot(input.tokensAtOpen ?? null),
    });
  return getEngagementById(Number(res.lastInsertRowid));
}

export interface CloseByIdInput {
  id: number;
  startedAt: string;
  closeReason: string;
  tokensAtClose?: TokenSnapshot | null;
  endedAt: string;
}

/**
 * Compare-and-close primitive: close the interval iff it is still the same OPEN
 * row identified by (`id`, `started_at`). Returns true when a row was closed,
 * false when it was already closed / re-opened (no clobber).
 */
export function closeEngagementById(input: CloseByIdInput): boolean {
  const res = getSessionDb()
    .prepare(
      `UPDATE engagement
          SET ended_at = @endedAt,
              tokens_at_close = @tokensAtClose,
              close_reason = @closeReason
        WHERE id = @id AND started_at = @startedAt AND ended_at IS NULL`,
    )
    .run({
      id: input.id,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      tokensAtClose: serializeSnapshot(input.tokensAtClose ?? null),
      closeReason: input.closeReason,
    });
  return res.changes > 0;
}

export interface CloseOpenInput {
  closeReason: string;
  tokensAtClose?: TokenSnapshot | null;
  endedAt?: string;
}

/** Close the session's current open engagement (if any). Returns true if closed. */
export function closeOpenEngagement(
  sessionId: string,
  input: CloseOpenInput,
): boolean {
  const open = getOpenEngagement(sessionId);
  if (!open) return false;
  return closeEngagementById({
    id: open.id,
    startedAt: open.started_at,
    closeReason: input.closeReason,
    tokensAtClose: input.tokensAtClose ?? null,
    endedAt: input.endedAt ?? new Date().toISOString(),
  });
}

/**
 * Idempotent ensure-open: if the session already has an open engagement, do
 * nothing (preserve "don't clobber" — no auto-switch; semantics belong to the
 * attribution-rewiring assignment) and return null. Otherwise open one and
 * return it. Tolerates a concurrent open winning the race (unique conflict ⇒
 * treated as "already open").
 */
export function ensureOpenEngagement(input: OpenEngagementInput): EngagementRow | null {
  if (getOpenEngagement(input.sessionId)) return null;
  try {
    return openEngagement(input);
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
      return null;
    }
    throw err;
  }
}

export interface SwitchEngagementInput {
  sessionId: string;
  assignmentId?: string | null;
  projectSlug?: string | null;
  assignmentSlug?: string | null;
  stage?: string;
  startedAt: string;
  /** Pre-captured snapshot (await the async source BEFORE calling — Decision 11). */
  tokensSnapshot?: TokenSnapshot | null;
}

/**
 * Switch the session to a new (assignment, stage): close the current open
 * interval and open a new one in ONE synchronous IMMEDIATE transaction, using
 * the SAME pre-captured snapshot as tokens_at_close(old) = tokens_at_open(new).
 */
export function switchEngagement(input: SwitchEngagementInput): EngagementRow {
  const db = getSessionDb();
  const snapshot = input.tokensSnapshot ?? null;
  const run = db.transaction((): EngagementRow => {
    const open = getOpenEngagement(input.sessionId);
    if (open) {
      closeEngagementById({
        id: open.id,
        startedAt: open.started_at,
        closeReason: 'switch',
        tokensAtClose: snapshot,
        endedAt: input.startedAt,
      });
    }
    return openEngagement({
      sessionId: input.sessionId,
      assignmentId: input.assignmentId ?? null,
      projectSlug: input.projectSlug ?? null,
      assignmentSlug: input.assignmentSlug ?? null,
      stage: input.stage,
      startedAt: input.startedAt,
      tokensAtOpen: snapshot,
    });
  });
  return run.immediate();
}
