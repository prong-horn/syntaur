import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { syntaurRoot } from '../utils/paths.js';
import { generateId } from '../utils/uuid.js';

let db: Database.Database | null = null;

const EVENTS_SCHEMA_VERSION = '1';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL,
  project_slug TEXT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  details TEXT,
  source_key TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_events_assignment_at ON events(assignment_id, at);
CREATE INDEX IF NOT EXISTS idx_events_at ON events(at);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

export interface EventRow {
  event_id: string;
  assignment_id: string;
  project_slug: string | null;
  at: string;
  actor: string;
  type: string;
  details: string | null;
  source_key: string | null;
}

/** Raw row shape for the module-private INSERT. */
interface InsertEventRow {
  event_id: string;
  assignment_id: string;
  project_slug: string | null;
  at: string;
  actor: string;
  type: string;
  details: string | null;
  source_key: string | null;
}

/** Caller-facing input for the single exported writer, `recordEvent`. */
export interface RecordEventInput {
  assignmentId: string;
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
 * file as `session-db.ts` / `proof-db.ts` but owns its own
 * `events_schema_version` meta row so they can coexist. Mirrors the singleton
 * + WAL + exclusive-migration pattern from `src/db/proof-db.ts`.
 */
export function initEventsDb(dbPath?: string): Database.Database {
  if (db) return db;

  const finalPath = dbPath ?? resolve(syntaurRoot(), 'syntaur.db');
  db = new Database(finalPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);

  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(
    'events_schema_version',
    EVENTS_SCHEMA_VERSION,
  );

  // No migrations yet for v1, but run an exclusive transaction to set the
  // pattern for v2+ (mirrors proof-db.ts + session-db.ts). Each future
  // versioned step re-reads `events_schema_version` inside the transaction and
  // gates on the prior version, then bumps it — e.g.:
  //
  //   const vBeforeV2 = (database
  //     .prepare("SELECT value FROM meta WHERE key = 'events_schema_version'")
  //     .get() as { value: string } | undefined)?.value;
  //   if (vBeforeV2 === '1') {
  //     database.exec(`... ; UPDATE meta SET value = '2' WHERE key = 'events_schema_version';`);
  //   }
  //
  // EXCLUSIVE serializes concurrent initEventsDb() calls (CLI + dashboard) and
  // rolls back a half-applied upgrade on crash.
  const database = db;
  const runMigrations = database.transaction(() => {
    // future migrations go here
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
      `INSERT OR IGNORE INTO events (event_id, assignment_id, project_slug, at, actor, type, details, source_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.event_id,
      row.assignment_id,
      row.project_slug,
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

    let details: string | null = null;
    if (input.details !== undefined && input.details !== null) {
      details =
        typeof input.details === 'string' ? input.details : JSON.stringify(input.details);
    }

    insertEvent({
      event_id: generateId(),
      assignment_id: input.assignmentId,
      project_slug: input.projectSlug ?? null,
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
 * List events for an assignment, newest-first (`ORDER BY at DESC`). Optional
 * filters: `since` (`at >= since`), `types` (`type IN (...)`), `limit`.
 */
export function listEventsByAssignment(
  assignmentId: string,
  filters?: ListEventsFilters,
): EventRow[] {
  const database = getEventsDb();

  const clauses: string[] = ['assignment_id = ?'];
  const params: Array<string | number> = [assignmentId];

  if (filters?.since) {
    clauses.push('at >= ?');
    params.push(filters.since);
  }

  if (filters?.types && filters.types.length > 0) {
    const placeholders = filters.types.map(() => '?').join(', ');
    clauses.push(`type IN (${placeholders})`);
    params.push(...filters.types);
  }

  let sql = `SELECT event_id, assignment_id, project_slug, at, actor, type, details, source_key
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
 * Whether any events exist for an assignment. Used ONLY for the backfill
 * dry-run preview count — NOT as an idempotency gate (idempotency is the
 * `source_key` UNIQUE constraint via `INSERT OR IGNORE`).
 */
export function hasEventsForAssignment(assignmentId: string): boolean {
  const database = getEventsDb();
  const row = database
    .prepare('SELECT 1 FROM events WHERE assignment_id = ? LIMIT 1')
    .get(assignmentId);
  return row !== undefined;
}
