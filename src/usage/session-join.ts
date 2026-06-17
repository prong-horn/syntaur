/**
 * Resolve `(sessionId, cwd, eventTs) → (projectSlug, assignmentSlug)` against
 * the existing `sessions` table (see `src/dashboard/session-db.ts`). Read-
 * only access; no schema changes to `sessions`.
 *
 * Resolution stages:
 *   1. PK match on `session_id` (fast, exact).
 *   2a. Fuzzy fallback by `sessions.path = cwd` within the exact `julianday()`
 *       time window — `julianday()` (not lexicographic) because `started` is
 *       ISO 8601 but `ended` is SQLite `YYYY-MM-DD HH:MM:SS`.
 *   2b. Day-granularity fallback, only when the event timestamp is a date-only
 *       UTC-midnight snap (Claude's date-only `lastActivity`), and only when the
 *       day's same-cwd sessions resolve to exactly one project/assignment. This
 *       recovers Claude usage that 2a drops (no session starts at 00:00:00Z)
 *       without guessing on ambiguous days.
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

  // Stage 2a: exact julianday time-window match by path. Correct for events
  // that carry a full ISO instant (codex/opencode).
  if (input.cwd) {
    const exact = database
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
    if (exact) {
      return { projectSlug: exact.project_slug, assignmentSlug: exact.assignment_slug };
    }

    // Stage 2b: day-granularity fallback, ONLY for date-only events that
    // `normalizeLastActivity` snapped to UTC midnight (Claude's ccusage
    // `lastActivity` is date-only, so the exact instant window above always
    // misses — no session starts at 00:00:00Z). `date()` parses both ISO `…Z`
    // and SQLite `YYYY-MM-DD HH:MM:SS`. Restricting to the midnight snap avoids
    // day-matching a genuinely out-of-window full-ISO event; the ambiguity
    // guard (exactly one distinct project/assignment) avoids guessing when two
    // sessions shared the cwd that day.
    if (input.eventTs.endsWith('T00:00:00.000Z')) {
      const sameDay = database
        .prepare(
          `SELECT DISTINCT project_slug, assignment_slug
             FROM sessions
            WHERE path = ?
              AND date(started) <= date(?)
              AND (ended IS NULL OR date(ended) >= date(?))`,
        )
        .all(input.cwd, input.eventTs, input.eventTs) as AttributionRow[];
      if (sameDay.length === 1) {
        return {
          projectSlug: sameDay[0].project_slug,
          assignmentSlug: sameDay[0].assignment_slug,
        };
      }
    }
  }

  return { projectSlug: null, assignmentSlug: null };
}
