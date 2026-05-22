/**
 * Resolve `(sessionId, cwd, eventTs) → (projectSlug, assignmentSlug)` against
 * the existing `sessions` table (see `src/dashboard/session-db.ts`). Read-
 * only access; no schema changes to `sessions`.
 *
 * Two-stage resolution:
 *   1. PK match on `session_id` (fast, exact).
 *   2. Fuzzy fallback by `sessions.path = cwd` within the session's time
 *      window — uses `julianday()` because `sessions.started` is ISO 8601
 *      (`new Date().toISOString()`) but `sessions.ended` is SQLite
 *      `datetime('now')` format (`YYYY-MM-DD HH:MM:SS`). Lexicographic
 *      comparison would be incorrect across the two formats.
 *
 * Returns `{projectSlug: null, assignmentSlug: null}` when neither stage
 * matches — the caller stores `''` (the schema NOT-NULL default) so the
 * unattributed bucket is queryable.
 */

import type Database from 'better-sqlite3';
import { getSessionDb } from '../dashboard/session-db.js';

export interface AttributionInput {
  sessionId: string;
  cwd: string | null;
  eventTs: string;
}

export interface AttributionResult {
  projectSlug: string | null;
  assignmentSlug: string | null;
}

interface AttributionRow {
  project_slug: string | null;
  assignment_slug: string | null;
}

/**
 * Resolve attribution for a single event. The caller must have already
 * called `initSessionDb()` so `getSessionDb()` returns a live handle.
 *
 * `db` is an optional override used in tests to inject a separate
 * better-sqlite3 handle. In production, omit it.
 */
export function resolveAttribution(
  input: AttributionInput,
  db?: Database.Database,
): AttributionResult {
  const database = db ?? getSessionDb();

  // Stage 1: PK match.
  const direct = database
    .prepare(
      `SELECT project_slug, assignment_slug
         FROM sessions
        WHERE session_id = ?`,
    )
    .get(input.sessionId) as AttributionRow | undefined;
  if (direct) {
    return {
      projectSlug: direct.project_slug,
      assignmentSlug: direct.assignment_slug,
    };
  }

  // Stage 2: fuzzy fallback by path + julianday time-window match.
  if (input.cwd) {
    const fuzzy = database
      .prepare(
        `SELECT project_slug, assignment_slug
           FROM sessions
          WHERE path = ?
            AND julianday(started) <= julianday(?)
            AND (ended IS NULL OR julianday(ended) >= julianday(?))
          ORDER BY started DESC
          LIMIT 1`,
      )
      .get(input.cwd, input.eventTs, input.eventTs) as AttributionRow | undefined;
    if (fuzzy) {
      return {
        projectSlug: fuzzy.project_slug,
        assignmentSlug: fuzzy.assignment_slug,
      };
    }
  }

  return { projectSlug: null, assignmentSlug: null };
}
