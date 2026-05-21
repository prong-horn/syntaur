/**
 * Token-usage tracking database module.
 *
 * Shares `~/.syntaur/syntaur.db` with `session-db.ts`, `leases-db.ts`, and
 * `proof-db.ts`. Each module owns its own schema-version row in the shared
 * `meta` table; init order is irrelevant.
 *
 * v1 design (see decision-record.md Decisions 3 + 4):
 *   - `usage_events` PK is (session_id, model). UPSERT semantics — re-running
 *     the collector against unchanged ccusage output produces the same DB
 *     state. ccusage reports cumulative session totals (no per-turn deltas),
 *     so each row is a mutable snapshot of cumulative tokens for that
 *     (session, model) pair.
 *   - `usage_daily` is recomputed-from-scratch on every collector run via
 *     `insertDailyBatch`. The `frozen` column is reserved for v2's
 *     closed-session promotion; v1 always writes frozen=0 and `runRollup`
 *     deletes only `WHERE frozen = 0` so future v2 rows survive.
 *   - NO foreign key to sessions(session_id); ccusage will surface sessions
 *     Syntaur never tracked. Attribution is a logical join, not a referential
 *     one.
 */

import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { syntaurRoot } from '../utils/paths.js';

let db: Database.Database | null = null;

const USAGE_SCHEMA_VERSION = '1';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS usage_events (
  session_id              TEXT    NOT NULL,
  model                   TEXT    NOT NULL,
  tool                    TEXT    NOT NULL,
  event_ts                TEXT    NOT NULL,
  input_tokens            INTEGER NOT NULL DEFAULT 0,
  output_tokens           INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
  total_tokens            INTEGER NOT NULL DEFAULT 0,
  total_cost              REAL    NOT NULL DEFAULT 0,
  cwd                     TEXT,
  project_slug            TEXT    NOT NULL DEFAULT '',
  assignment_slug         TEXT    NOT NULL DEFAULT '',
  raw_json                TEXT,
  updated_at              TEXT    NOT NULL,
  PRIMARY KEY (session_id, model)
);

CREATE INDEX IF NOT EXISTS idx_usage_events_ts
  ON usage_events (event_ts);
CREATE INDEX IF NOT EXISTS idx_usage_events_attribution
  ON usage_events (project_slug, assignment_slug);
CREATE INDEX IF NOT EXISTS idx_usage_events_cwd
  ON usage_events (cwd, event_ts);

CREATE TABLE IF NOT EXISTS usage_daily (
  day                     TEXT    NOT NULL,
  tool                    TEXT    NOT NULL,
  model                   TEXT    NOT NULL,
  project_slug            TEXT    NOT NULL DEFAULT '',
  assignment_slug         TEXT    NOT NULL DEFAULT '',
  input_tokens            INTEGER NOT NULL DEFAULT 0,
  output_tokens           INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
  total_tokens            INTEGER NOT NULL DEFAULT 0,
  total_cost              REAL    NOT NULL DEFAULT 0,
  frozen                  INTEGER NOT NULL DEFAULT 0,
  computed_at             TEXT    NOT NULL,
  PRIMARY KEY (day, tool, model, project_slug, assignment_slug)
);

CREATE INDEX IF NOT EXISTS idx_usage_daily_day
  ON usage_daily (day);
`;

// --- Types -----------------------------------------------------------------

export interface UsageEventInput {
  sessionId: string;
  model: string;
  tool: string;
  eventTs: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  cwd: string | null;
  projectSlug: string;
  assignmentSlug: string;
  rawJson: string | null;
}

export interface UsageEventRow {
  session_id: string;
  model: string;
  tool: string;
  event_ts: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  total_cost: number;
  cwd: string | null;
  project_slug: string;
  assignment_slug: string;
  raw_json: string | null;
  updated_at: string;
}

export interface UsageDailyInput {
  day: string;
  tool: string;
  model: string;
  projectSlug: string;
  assignmentSlug: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
}

export interface UsageDailyRow {
  day: string;
  tool: string;
  model: string;
  project_slug: string;
  assignment_slug: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  total_cost: number;
  frozen: number;
  computed_at: string;
}

export interface ListEventsFilter {
  since?: string;
  until?: string;
  projectSlug?: string;
  assignmentSlug?: string;
  tool?: string;
}

export interface ListDailyFilter {
  since?: string;
  until?: string;
  projectSlug?: string;
  assignmentSlug?: string;
  tool?: string;
}

// --- Helpers ---------------------------------------------------------------

/** Canonical UTC ISO 8601 timestamp. Lexicographic-safe for SQL `<=` checks. */
export function nowIso(): string {
  return new Date().toISOString();
}

// --- Lifecycle -------------------------------------------------------------

/**
 * Initialize the usage database. Idempotent — repeated calls return the same
 * singleton handle. Pass an explicit `dbPath` for tests; defaults to
 * `~/.syntaur/syntaur.db`. Safe to run standalone (creates its own `meta`
 * table).
 */
export function initUsageDb(dbPath?: string): Database.Database {
  if (db) return db;

  const finalPath = dbPath ?? resolve(syntaurRoot(), 'syntaur.db');
  db = new Database(finalPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  const database = db;
  const runMigrations = database.transaction(() => {
    database.exec(SCHEMA_SQL);
    database
      .prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)')
      .run('usage_schema_version', USAGE_SCHEMA_VERSION);
  });
  runMigrations.exclusive();

  return db;
}

export function getUsageDb(): Database.Database {
  if (!db) {
    throw new Error('Usage database not initialized. Call initUsageDb() first.');
  }
  return db;
}

export function closeUsageDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** Test helper — drop the singleton without closing (for `beforeEach` resets). */
export function resetUsageDb(): void {
  db = null;
}

// --- Meta ------------------------------------------------------------------

export function getMeta(key: string): string | null {
  const database = getUsageDb();
  const row = database.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  const database = getUsageDb();
  database
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

/**
 * Monotonic variant of `setMeta`: only advance the stored ISO timestamp when
 * the incoming value is lexicographically greater than the existing one
 * (canonical UTC ISO 8601 is lexicographic-safe). Use for `usage_last_collector_run`
 * so an out-of-order collector finish can't regress the high-water mark.
 *
 * Returns true when the value was updated, false otherwise.
 */
export function advanceMetaIso(key: string, value: string): boolean {
  const database = getUsageDb();
  const res = database
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value
       WHERE excluded.value > meta.value`,
    )
    .run(key, value);
  return res.changes > 0;
}

// --- Events ----------------------------------------------------------------

/**
 * Upsert one usage event. Idempotent on `(session_id, model)` — re-running
 * the collector against unchanged ccusage output produces the same DB state.
 * Growing sessions refresh their row in place.
 *
 * Monotonicity guards (codex code-review CRITICAL + NEW HIGH on same-day
 * timestamp regressions):
 *   - Token counts and cost use `MAX(excluded, existing)`. ccusage reports
 *     CUMULATIVE per-session totals — they only grow over a session's life
 *     — so a smaller incoming value can only mean "older snapshot finished
 *     later than a newer one." Take the larger. Survives equal-`event_ts`
 *     ties (Claude's date-only `lastActivity` normalizes multiple same-day
 *     snapshots to the same UTC midnight).
 *   - `event_ts` advances via MAX so the latest observation timestamp wins.
 *   - `tool` and `raw_json` advance only when `excluded.event_ts > existing`
 *     so out-of-order finishes don't overwrite a fresher snapshot's
 *     metadata.
 *   - Attribution columns (`cwd`, `project_slug`, `assignment_slug`) are
 *     preserved when incoming is empty. This protects the same-day re-collect
 *     path where the JSONL cwd-walk skipped a session whose mtime predates
 *     the cutoff: without this guard the UPSERT would erase the attribution
 *     recorded by the first collect.
 */
export function upsertEvent(input: UsageEventInput): void {
  const database = getUsageDb();
  database
    .prepare(
      `INSERT INTO usage_events (
         session_id, model, tool, event_ts,
         input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
         total_tokens, total_cost,
         cwd, project_slug, assignment_slug, raw_json, updated_at
       ) VALUES (
         @sessionId, @model, @tool, @eventTs,
         @inputTokens, @outputTokens, @cacheCreationTokens, @cacheReadTokens,
         @totalTokens, @totalCost,
         @cwd, @projectSlug, @assignmentSlug, @rawJson, @updatedAt
       )
       ON CONFLICT(session_id, model) DO UPDATE SET
         tool                  = CASE WHEN excluded.event_ts >  usage_events.event_ts THEN excluded.tool     ELSE usage_events.tool     END,
         event_ts              = CASE WHEN excluded.event_ts >  usage_events.event_ts THEN excluded.event_ts ELSE usage_events.event_ts END,
         input_tokens          = MAX(excluded.input_tokens,          usage_events.input_tokens),
         output_tokens         = MAX(excluded.output_tokens,         usage_events.output_tokens),
         cache_creation_tokens = MAX(excluded.cache_creation_tokens, usage_events.cache_creation_tokens),
         cache_read_tokens     = MAX(excluded.cache_read_tokens,     usage_events.cache_read_tokens),
         total_tokens          = MAX(excluded.total_tokens,          usage_events.total_tokens),
         total_cost            = MAX(excluded.total_cost,            usage_events.total_cost),
         cwd                   = COALESCE(NULLIF(excluded.cwd, ''), usage_events.cwd),
         project_slug          = CASE WHEN excluded.project_slug    != '' THEN excluded.project_slug    ELSE usage_events.project_slug    END,
         assignment_slug       = CASE WHEN excluded.assignment_slug != '' THEN excluded.assignment_slug ELSE usage_events.assignment_slug END,
         raw_json              = CASE WHEN excluded.event_ts >  usage_events.event_ts THEN excluded.raw_json ELSE usage_events.raw_json END,
         updated_at            = excluded.updated_at`,
    )
    .run({
      sessionId: input.sessionId,
      model: input.model,
      tool: input.tool,
      eventTs: input.eventTs,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheCreationTokens: input.cacheCreationTokens,
      cacheReadTokens: input.cacheReadTokens,
      totalTokens: input.totalTokens,
      totalCost: input.totalCost,
      cwd: input.cwd,
      projectSlug: input.projectSlug,
      assignmentSlug: input.assignmentSlug,
      rawJson: input.rawJson,
      updatedAt: nowIso(),
    });
}

export function listEvents(filter: ListEventsFilter = {}): UsageEventRow[] {
  const database = getUsageDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.since) {
    where.push('event_ts >= ?');
    params.push(filter.since);
  }
  if (filter.until) {
    where.push('event_ts <= ?');
    params.push(filter.until);
  }
  if (filter.projectSlug !== undefined) {
    where.push('project_slug = ?');
    params.push(filter.projectSlug);
  }
  if (filter.assignmentSlug !== undefined) {
    where.push('assignment_slug = ?');
    params.push(filter.assignmentSlug);
  }
  if (filter.tool) {
    where.push('tool = ?');
    params.push(filter.tool);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return database
    .prepare(
      `SELECT session_id, model, tool, event_ts,
              input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
              total_tokens, total_cost,
              cwd, project_slug, assignment_slug, raw_json, updated_at
         FROM usage_events ${whereSql}
        ORDER BY event_ts DESC`,
    )
    .all(...params) as UsageEventRow[];
}

// --- Daily rollup ---------------------------------------------------------

/**
 * Atomic recompute-from-scratch primitive for v1: deletes all rows where
 * `frozen = 0`, then inserts every row in `rows` with `frozen = 0`. Pre-
 * existing frozen rows (v2 forward-compat) are left untouched.
 *
 * Single `BEGIN IMMEDIATE` transaction so readers don't see a half-empty
 * partition.
 */
export function insertDailyBatch(rows: UsageDailyInput[]): void {
  const database = getUsageDb();
  const computedAt = nowIso();

  const insert = database.prepare(
    `INSERT INTO usage_daily (
       day, tool, model, project_slug, assignment_slug,
       input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
       total_tokens, total_cost, frozen, computed_at
     ) VALUES (
       @day, @tool, @model, @projectSlug, @assignmentSlug,
       @inputTokens, @outputTokens, @cacheCreationTokens, @cacheReadTokens,
       @totalTokens, @totalCost, 0, @computedAt
     )`,
  );

  const tx = database.transaction(() => {
    database.prepare('DELETE FROM usage_daily WHERE frozen = 0').run();
    for (const row of rows) {
      insert.run({
        day: row.day,
        tool: row.tool,
        model: row.model,
        projectSlug: row.projectSlug,
        assignmentSlug: row.assignmentSlug,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheCreationTokens: row.cacheCreationTokens,
        cacheReadTokens: row.cacheReadTokens,
        totalTokens: row.totalTokens,
        totalCost: row.totalCost,
        computedAt,
      });
    }
  });

  tx.immediate();
}

export function listDaily(filter: ListDailyFilter = {}): UsageDailyRow[] {
  const database = getUsageDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.since) {
    where.push('day >= ?');
    params.push(filter.since);
  }
  if (filter.until) {
    where.push('day <= ?');
    params.push(filter.until);
  }
  if (filter.projectSlug !== undefined) {
    where.push('project_slug = ?');
    params.push(filter.projectSlug);
  }
  if (filter.assignmentSlug !== undefined) {
    where.push('assignment_slug = ?');
    params.push(filter.assignmentSlug);
  }
  if (filter.tool) {
    where.push('tool = ?');
    params.push(filter.tool);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return database
    .prepare(
      `SELECT day, tool, model, project_slug, assignment_slug,
              input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
              total_tokens, total_cost, frozen, computed_at
         FROM usage_daily ${whereSql}
        ORDER BY day DESC, project_slug, assignment_slug, tool, model`,
    )
    .all(...params) as UsageDailyRow[];
}
