/**
 * The time-based stale sweep (phase 4, Decision 4).
 *
 * The transcript scanner used to decide liveness from a transcript's mtime, an
 * `lsof` of that transcript, a pid start-time guard and a `claude agents --json`
 * join — 576 lines to answer "is this row still a live session?". It is gone.
 * What replaces it is one query: an `active` row that nothing has touched for
 * longer than the idle window is marked `stopped` and its open engagement is
 * closed with reason `stale-sweep`.
 *
 * Two kinds of row are exempt:
 *
 *   - `hosted_by = 'acp'` — a chat session is owned by the broker, which writes
 *     `active` and `stopped` itself (idle teardown, adapter exit, shutdown) and
 *     revives the row on resume. Sweeping it would fight the owner.
 *   - anything touched inside the window. `updated_at` moves on register, on
 *     revive, on a status change and — new in this phase — on the rate-limited
 *     `syntaur session touch --from-hook` that the `PostToolUse` and
 *     `UserPromptSubmit` hooks call. Without that heartbeat any session longer
 *     than the window would be swept alive, which is why the touch hooks are
 *     part of the design rather than an option.
 *
 * Accepted residual risk (Decision 4): a session with neither a prompt nor a
 * tool call for the whole window — an idle terminal — is swept while alive. It
 * re-registers itself on its next hook event.
 */

import { getSessionDb } from '../dashboard/session-db.js';
import { closeEngagementById, getOpenEngagement } from '../db/engagement-db.js';
import { readConfig } from '../utils/config.js';

/** Rows the sweep would stop, before it stops them. */
interface StaleRow {
  session_id: string;
  updated_at: string;
}

export interface StaleSweepOptions {
  /**
   * Idle window in milliseconds. Defaults to `session.idleSweepHours` from
   * `config.md` (6 h), which is the same knob the scanner's idle sweep used.
   */
  idleMs?: number;
  /** Injected clock, for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface StaleSweepResult {
  /** Session ids moved from `active` to `stopped`. */
  swept: string[];
  /** How many of those also had an open engagement closed. */
  engagementsClosed: number;
}

/**
 * Sweep `active`, non-`acp` sessions idle longer than the window.
 *
 * The `ended` timestamp is the row's own `updated_at` — the last moment we have
 * evidence the session was alive — not "now", so a swept row does not claim to
 * have run for the whole idle window. The engagement is closed at the same
 * instant for the same reason.
 */
export async function sweepStaleSessions(
  options: StaleSweepOptions = {},
): Promise<StaleSweepResult> {
  const now = options.now ?? Date.now;
  const idleMs = options.idleMs ?? (await resolveIdleMs());
  const db = getSessionDb();

  // SQLite stores `updated_at` as `YYYY-MM-DD HH:MM:SS` in UTC (the DEFAULT is
  // `datetime('now')`), while `appendSession` writes an ISO-8601 string. Compare
  // in SQLite's own datetime space so both shapes order correctly.
  const cutoff = new Date(now() - idleMs).toISOString().replace('T', ' ').slice(0, 19);
  const stale = db
    .prepare(
      `SELECT session_id, updated_at FROM sessions
        WHERE status = 'active'
          AND (hosted_by IS NULL OR hosted_by != 'acp')
          AND datetime(REPLACE(updated_at, 'T', ' ')) < datetime(?)`,
    )
    .all(cutoff) as StaleRow[];

  const result: StaleSweepResult = { swept: [], engagementsClosed: 0 };
  if (stale.length === 0) return result;

  const stop = db.prepare(
    `UPDATE sessions
        SET status = 'stopped', ended = COALESCE(ended, @endedAt), updated_at = @endedAt
      WHERE session_id = @sessionId AND status = 'active'`,
  );

  for (const row of stale) {
    const endedAt = normalizeIso(row.updated_at);
    const changed = stop.run({ sessionId: row.session_id, endedAt }).changes;
    if (changed === 0) continue; // raced with the broker or a concurrent session stop
    result.swept.push(row.session_id);
    const open = getOpenEngagement(row.session_id);
    if (
      open &&
      closeEngagementById({
        id: open.id,
        startedAt: open.started_at,
        endedAt,
        closeReason: 'stale-sweep',
      })
    ) {
      result.engagementsClosed += 1;
    }
  }
  return result;
}

/** The configured idle window in ms, falling back to 6 h if config is unreadable. */
async function resolveIdleMs(): Promise<number> {
  try {
    const hours = (await readConfig()).session.idleSweepHours;
    if (Number.isFinite(hours) && hours > 0) return hours * 60 * 60 * 1000;
  } catch {
    // A broken config.md must not disable the sweep entirely.
  }
  return 6 * 60 * 60 * 1000;
}

/** `YYYY-MM-DD HH:MM:SS` (SQLite) or an ISO string → an ISO string. */
function normalizeIso(value: string): string {
  if (value.includes('T')) return value;
  return `${value.replace(' ', 'T')}Z`;
}
