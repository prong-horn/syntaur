/**
 * Resolve `(sessionId, cwd, eventTs) → (projectSlug, assignmentSlug)`.
 *
 * v6: the scalar binding moved off `sessions` onto the append-only `engagement`
 * edge, so attribution is now **interval-aware** — it returns the binding of the
 * engagement whose `[started_at, ended_at)` interval contains `eventTs`. This
 * correctly attributes usage for a session that worked multiple assignments over
 * its lifetime. Read-only.
 *
 * Resolution stages:
 *   1. PK match on `session_id`: the engagement interval (for that session)
 *      containing `eventTs`.
 *   2a. Fuzzy fallback by `sessions.path = cwd` within the exact `julianday()`
 *       session window, binding via the engagement interval containing `eventTs`
 *       — `julianday()` (not lexicographic) because `started` is ISO 8601 but
 *       `ended`/`ended_at` may be SQLite `YYYY-MM-DD HH:MM:SS`.
 *   2b. Day-granularity fallback, only when the event timestamp is a date-only
 *       UTC-midnight snap (Claude's date-only `lastActivity`), and only when the
 *       day's same-cwd engagements resolve to exactly one project/assignment.
 *
 * Returns `{projectSlug: null, assignmentSlug: null}` when no stage matches —
 * the caller stores `''` (the schema NOT-NULL default) so the unattributed
 * bucket is queryable.
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

  // Stage 1: PK match — the engagement interval (for this session) containing
  // the event timestamp.
  const direct = database
    .prepare(
      `SELECT project_slug, assignment_slug
         FROM engagement
        WHERE session_id = ?
          AND julianday(started_at) <= julianday(?)
          AND (ended_at IS NULL OR julianday(ended_at) > julianday(?))
        ORDER BY julianday(started_at) DESC
        LIMIT 1`,
    )
    .get(input.sessionId, input.eventTs, input.eventTs) as AttributionRow | undefined;
  if (direct) {
    return {
      projectSlug: direct.project_slug,
      assignmentSlug: direct.assignment_slug,
    };
  }

  // Stage 2a: exact julianday time-window match by session path, binding via the
  // engagement interval that contains the event. Correct for events that carry a
  // full ISO instant (codex/opencode). Most-recently-started session wins.
  if (input.cwd) {
    const exact = database
      .prepare(
        `SELECT e.project_slug AS project_slug, e.assignment_slug AS assignment_slug
           FROM sessions s
           JOIN engagement e ON e.session_id = s.session_id
          WHERE s.path = ?
            AND julianday(s.started) <= julianday(?)
            AND (s.ended IS NULL OR julianday(s.ended) >= julianday(?))
            AND julianday(e.started_at) <= julianday(?)
            AND (e.ended_at IS NULL OR julianday(e.ended_at) > julianday(?))
          ORDER BY julianday(s.started) DESC, julianday(e.started_at) DESC
          LIMIT 1`,
      )
      .get(
        input.cwd,
        input.eventTs,
        input.eventTs,
        input.eventTs,
        input.eventTs,
      ) as AttributionRow | undefined;
    if (exact) {
      return { projectSlug: exact.project_slug, assignmentSlug: exact.assignment_slug };
    }

    // Stage 2b: day-granularity fallback, ONLY for date-only events that
    // `normalizeLastActivity` snapped to UTC midnight (Claude's ccusage
    // `lastActivity` is date-only, so the exact instant window above always
    // misses — no session starts at 00:00:00Z). `date()` parses both ISO `…Z`
    // and SQLite `YYYY-MM-DD HH:MM:SS`. The ambiguity guard (exactly one
    // distinct project/assignment) avoids guessing when two sessions shared the
    // cwd that day.
    if (input.eventTs.endsWith('T00:00:00.000Z')) {
      const sameDay = database
        .prepare(
          `SELECT DISTINCT e.project_slug AS project_slug, e.assignment_slug AS assignment_slug
             FROM sessions s
             JOIN engagement e ON e.session_id = s.session_id
            WHERE s.path = ?
              AND date(s.started) <= date(?)
              AND (s.ended IS NULL OR date(s.ended) >= date(?))
              AND date(e.started_at) <= date(?)
              AND (e.ended_at IS NULL OR date(e.ended_at) >= date(?))`,
        )
        .all(
          input.cwd,
          input.eventTs,
          input.eventTs,
          input.eventTs,
          input.eventTs,
        ) as AttributionRow[];
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
