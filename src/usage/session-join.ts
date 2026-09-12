/**
 * Resolve `(sessionId, cwd, eventTs) → (projectSlug, ticketSlug)`.
 *
 * v6: the scalar binding moved off `sessions` onto the append-only `engagement`
 * edge, so this BINDING resolution is **interval-aware** — it returns the binding
 * of the engagement whose `[started_at, ended_at)` interval contains `eventTs`.
 *
 * After Decision 7 the engagement edge stores only `ticket_id`; the returned
 * `ticketSlug` carries that id for the `usage_events.ticket_id` column.
 *
 * NOTE (M2 / decision-record.md Decision 1): this resolves the *binding* only, it
 * does NOT split *cost*. `usage_events` is cumulative per `(session_id, model)`
 * with a date-only session-level `event_ts`, so a single cumulative row cannot be
 * decomposed across two engagement windows within one session/model. Per-ticket
 * COST therefore comes from engagement snapshot deltas (`usage/engagement-cost.ts`,
 * `tokens_at_close − tokens_at_open`), not from this join. This stays a best-effort
 * binding resolver, not a per-window cost splitter. Read-only.
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
  ticketSlug: string | null;
}

interface AttributionRow {
  ticket_id: string | null;
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

  const direct = database
    .prepare(
      `SELECT ticket_id
         FROM engagement
        WHERE session_id = ?
          AND julianday(started_at) <= julianday(?)
          AND (ended_at IS NULL OR julianday(ended_at) > julianday(?))
        ORDER BY julianday(started_at) DESC
        LIMIT 1`,
    )
    .get(input.sessionId, input.eventTs, input.eventTs) as AttributionRow | undefined;
  if (direct?.ticket_id) {
    return {
      projectSlug: null,
      ticketSlug: direct.ticket_id,
    };
  }

  if (input.cwd) {
    const exact = database
      .prepare(
        `SELECT e.ticket_id AS ticket_id
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
    if (exact?.ticket_id) {
      return { projectSlug: null, ticketSlug: exact.ticket_id };
    }

    if (input.eventTs.endsWith('T00:00:00.000Z')) {
      const sameDay = database
        .prepare(
          `SELECT DISTINCT e.ticket_id AS ticket_id
             FROM sessions s
             JOIN engagement e ON e.session_id = s.session_id
            WHERE s.path = ?
              AND date(s.started) <= date(?)
              AND (s.ended IS NULL OR date(s.ended) >= date(?))
              AND date(e.started_at) <= date(?)
              AND (e.ended_at IS NULL OR date(e.ended_at) >= date(?))
              AND e.ticket_id IS NOT NULL`,
        )
        .all(
          input.cwd,
          input.eventTs,
          input.eventTs,
          input.eventTs,
          input.eventTs,
        ) as AttributionRow[];
      if (sameDay.length === 1 && sameDay[0].ticket_id) {
        return {
          projectSlug: null,
          ticketSlug: sameDay[0].ticket_id,
        };
      }
    }
  }

  return { projectSlug: null, ticketSlug: null };
}
