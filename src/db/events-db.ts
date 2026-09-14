import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { syntaurRoot } from '../utils/paths.js';
import { generateId } from '../utils/uuid.js';

let db: Database.Database | null = null;

const EVENTS_SCHEMA_VERSION = '2';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  details TEXT,
  source_key TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_events_ticket_at ON events(ticket_id, at);
CREATE INDEX IF NOT EXISTS idx_events_at ON events(at);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

export interface EventRow {
  event_id: string;
  ticket_id: string;
  at: string;
  actor: string;
  type: string;
  details: string | null;
  source_key: string | null;
}

/** Raw row shape for the module-private INSERT. */
interface InsertEventRow {
  event_id: string;
  ticket_id: string;
  at: string;
  actor: string;
  type: string;
  details: string | null;
  source_key: string | null;
}

/** Caller-facing input for the single exported writer, `recordEvent`. */
export interface RecordEventInput {
  ticketId?: string;
  projectSlug?: string | null;
  type: string;
  /** Object (JSON-stringified before storage) or a pre-stringified string. NEVER pass secrets/raw bodies. */
  details?: unknown;
  actor: string;
  /** UTC ISO 8601. Defaults to now; backfill supplies a historical value. */
  at?: string;
  /** Deterministic key for backfilled events (null for live events; null always inserts). */
  sourceKey?: string | null;
}

export interface ListEventsFilters {
  /** Inclusive lower bound on `at` (`at >= since`). */
  since?: string;
  /** Restrict to these event types (`type IN (...)`). */
  types?: string[];
  /** Max rows returned. */
  limit?: number;
}

/**
 * Initialize the events database. Shares the same `~/.syntaur/syntaur.db`
 * file as `session-db.ts` but owns its own
 * `events_schema_version` meta row so they can coexist. Mirrors the singleton
 * + WAL + exclusive-migration pattern from `src/dashboard/session-db.ts`.
 */
export function initEventsDb(dbPath?: string): Database.Database {
  if (db) return db;

  const finalPath = dbPath ?? resolve(syntaurRoot(), 'syntaur.db');
  db = new Database(finalPath);
  db.pragma('journal_mode = WAL');

  const database = db;
  const runMigrations = database.transaction(() => {
    database.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
    database
      .prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)')
      .run('events_schema_version', EVENTS_SCHEMA_VERSION);

    const eventsVersion = (
      database
        .prepare("SELECT value FROM meta WHERE key = 'events_schema_version'")
        .get() as { value: string } | undefined
    )?.value;

    if (eventsVersion === '1') {
      database.exec(`
        CREATE TABLE events_v2 (
          event_id TEXT PRIMARY KEY,
          ticket_id TEXT NOT NULL,
          at TEXT NOT NULL,
          actor TEXT NOT NULL,
          type TEXT NOT NULL,
          details TEXT,
          source_key TEXT UNIQUE
        );
        INSERT INTO events_v2
          SELECT event_id, assignment_id, at, actor, type, details, source_key
          FROM events;
        DROP TABLE events;
        ALTER TABLE events_v2 RENAME TO events;
        UPDATE meta SET value = '2' WHERE key = 'events_schema_version';
      `);
    }

    database.exec(SCHEMA_SQL);
  });
  runMigrations.exclusive();

  return db;
}

export function getEventsDb(): Database.Database {
  if (!db) {
    throw new Error('Events database not initialized. Call initEventsDb() first.');
  }
  return db;
}

export function closeEventsDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function resetEventsDb(): void {
  db = null;
}

/**
 * Raw prepared INSERT. MODULE-PRIVATE: the only caller is `recordEvent`.
 * Uses `INSERT OR IGNORE` so a duplicate non-null `source_key` is a silent
 * no-op (SQLite exempts NULL from UNIQUE, so null keys always insert).
 */
function insertEvent(row: InsertEventRow): void {
  const database = getEventsDb();
  database
    .prepare(
      `INSERT OR IGNORE INTO events (event_id, ticket_id, at, actor, type, details, source_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.event_id,
      row.ticket_id,
      row.at,
      row.actor,
      row.type,
      row.details,
      row.source_key,
    );
}

/**
 * The ONLY exported writer. Best-effort: wraps the whole body in try/catch,
 * logs on failure, and NEVER throws — a logging failure must not break the
 * caller's mutation. Lazily initializes the DB if the singleton isn't open.
 *
 * `event_id` is generated; `at` defaults to now; `details` is JSON-stringified
 * (objects become strings; pre-stringified strings pass through). Callers must
 * never put secrets/raw bodies in `details`.
 */
export function recordEvent(input: RecordEventInput): void {
  try {
    if (!db) initEventsDb();
    const ticketId = input.ticketId;
    if (!ticketId) throw new Error('recordEvent requires ticketId');

    let details: string | null = null;
    if (input.details !== undefined && input.details !== null) {
      details =
        typeof input.details === 'string' ? input.details : JSON.stringify(input.details);
    }

    insertEvent({
      event_id: generateId(),
      ticket_id: ticketId,
      at: input.at ?? new Date().toISOString(),
      actor: input.actor,
      type: input.type,
      details,
      source_key: input.sourceKey ?? null,
    });
  } catch (e) {
    console.warn('[events] failed to record event:', e);
  }
}

/**
 * List events for a ticket, newest-first (`ORDER BY at DESC`). Optional
 * filters: `since` (`at >= since`), `types` (`type IN (...)`), `limit`.
 */
export function listEventsByTicket(
  ticketId: string,
  filters?: ListEventsFilters,
): EventRow[] {
  const database = getEventsDb();

  const clauses: string[] = ['ticket_id = ?'];
  const params: Array<string | number> = [ticketId];

  if (filters?.since) {
    clauses.push('at >= ?');
    params.push(filters.since);
  }

  if (filters?.types && filters.types.length > 0) {
    const placeholders = filters.types.map(() => '?').join(', ');
    clauses.push(`type IN (${placeholders})`);
    params.push(...filters.types);
  }

  let sql = `SELECT event_id, ticket_id, at, actor, type, details, source_key
       FROM events
       WHERE ${clauses.join(' AND ')}
       ORDER BY at DESC`;

  if (filters?.limit !== undefined) {
    sql += ' LIMIT ?';
    params.push(filters.limit);
  }

  return database.prepare(sql).all(...params) as EventRow[];
}

/**
 * Whether any events exist for a ticket. Used ONLY for the backfill
 * dry-run preview count — NOT as an idempotency gate (idempotency is the
 * `source_key` UNIQUE constraint via `INSERT OR IGNORE`).
 */
export function hasEventsForTicket(ticketId: string): boolean {
  const database = getEventsDb();
  const row = database
    .prepare('SELECT 1 FROM events WHERE ticket_id = ? LIMIT 1')
    .get(ticketId);
  return row !== undefined;
}

export interface LatestMove {
  at: string;
  from: string;
  to: string;
}

function parseMoveDetails(details: string | null): { from: string; to: string } | null {
  if (!details) return null;
  try {
    const parsed = JSON.parse(details) as { from?: unknown; to?: unknown };
    if (typeof parsed.from !== 'string' || typeof parsed.to !== 'string') return null;
    return { from: parsed.from, to: parsed.to };
  } catch {
    return null;
  }
}

/**
 * Latest `moved` event per ticket (one query). Tickets with no `moved` row are
 * omitted — callers fall back to `created` / `updated`.
 */
export function latestMovesByTicket(ticketIds: string[]): Map<string, LatestMove> {
  const out = new Map<string, LatestMove>();
  if (ticketIds.length === 0) return out;
  if (!db) initEventsDb();

  const database = getEventsDb();
  const placeholders = ticketIds.map(() => '?').join(', ');
  const rows = database
    .prepare(
      `SELECT ticket_id, at, details
       FROM events
       WHERE ticket_id IN (${placeholders}) AND type = 'moved'
       ORDER BY at DESC`,
    )
    .all(...ticketIds) as Array<{ ticket_id: string; at: string; details: string | null }>;

  for (const row of rows) {
    if (out.has(row.ticket_id)) continue;
    const endpoints = parseMoveDetails(row.details);
    if (!endpoints) continue;
    out.set(row.ticket_id, { at: row.at, from: endpoints.from, to: endpoints.to });
  }
  return out;
}

/**
 * Latest `created` event per ticket (one query). Used as the statusAge fallback
 * when no `moved` row exists.
 */
export function latestCreatedByTicket(ticketIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (ticketIds.length === 0) return out;
  if (!db) initEventsDb();

  const database = getEventsDb();
  const placeholders = ticketIds.map(() => '?').join(', ');
  const rows = database
    .prepare(
      `SELECT ticket_id, at
       FROM events
       WHERE ticket_id IN (${placeholders}) AND type = 'created'
       ORDER BY at DESC`,
    )
    .all(...ticketIds) as Array<{ ticket_id: string; at: string }>;

  for (const row of rows) {
    if (!out.has(row.ticket_id)) out.set(row.ticket_id, row.at);
  }
  return out;
}

/**
 * Latest `moved` event whose `to` matches `stage`, per ticket (one query).
 * Used for inbox `since` on review tickets.
 */
export function latestMovedToStageByTicket(
  ticketIds: string[],
  stage: string,
): Map<string, LatestMove> {
  const out = new Map<string, LatestMove>();
  if (ticketIds.length === 0) return out;
  if (!db) initEventsDb();

  const database = getEventsDb();
  const placeholders = ticketIds.map(() => '?').join(', ');
  const rows = database
    .prepare(
      `SELECT ticket_id, at, details
       FROM events
       WHERE ticket_id IN (${placeholders}) AND type = 'moved'
       ORDER BY at DESC`,
    )
    .all(...ticketIds) as Array<{ ticket_id: string; at: string; details: string | null }>;

  for (const row of rows) {
    if (out.has(row.ticket_id)) continue;
    const endpoints = parseMoveDetails(row.details);
    if (!endpoints || endpoints.to !== stage) continue;
    out.set(row.ticket_id, { at: row.at, from: endpoints.from, to: endpoints.to });
  }
  return out;
}
