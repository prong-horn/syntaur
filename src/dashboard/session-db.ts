import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { syntaurRoot } from '../utils/paths.js';
import { fileExists } from '../utils/fs.js';
import type { AgentSession, AgentSessionStatus } from './types.js';
import { ENGAGEMENT_DDL, ENGAGEMENT_SCHEMA_VERSION } from '../db/engagement-schema.js';
import { CHAT_DDL, CHAT_SCHEMA_VERSION } from '../db/chat-schema.js';
import { backfillEngagements } from '../db/engagement-backfill.js';
import { sanitizeSessionPath } from '../utils/transcript.js';

let db: Database.Database | null = null;

const SCHEMA_VERSION = '12';

// v10 base schema: v9 plus the two session curation flags — `pinned_at`
// (non-NULL ⇒ the session sorts ahead of the active sort on every browsing
// surface, most-recently-pinned first) and `archived_at` (non-NULL ⇒ the
// session is hidden from the default list queries but is never deleted).
// Nullable ISO-8601 TEXT timestamps rather than INTEGER booleans so pin order
// is deterministic and archiving is auditable.
//
// v12 base schema: v11 minus the five ops-subsystem tables (`lease_events`,
// `leases`, `inventory_members`, `inventories`, `artifacts`) and the
// `proof_schema_version` / `lease_schema_version` meta rows. The same drops
// also run unconditionally on every init via `dropRetiredTables()` so a stale
// CLI that recreates them with `CREATE TABLE IF NOT EXISTS` cannot leave them
// behind.
//
// v11 base schema: v10 minus everything the terminal-launch stack owned —
// the whole `launch_reservations` table, and the `pid`, `pid_started_at` and
// `activity` columns, which lost their last reader when `computeIsLive`, the
// transcript scanner and the Agent View went (phase 4, Decision 6).
// `transcript_path` STAYS: the summarizer chain, `listSessionsNeedingSummary`,
// the session commands, the doctor workspace check, and engagement backfill all read it.
//
// v9 base schema: v8 plus `launch_reservations` — pending-launch reservation
// records, never sessions rows; a failed dispatch must never strand an active
// session row. See Phase C plan D5.
//
// v8 base schema: v7 plus the auto-summary columns — `summary` (short blurb
// generated from the transcript), `summarized_at`, and `description_source`
// ('human' | 'auto' | NULL) which protects a human-written description from
// ever being overwritten by the summarizer.
//
// v7 base schema: v6 plus `hosted_by` (which backend hosts the live PTY:
// 'syntaurd' | 'tmux'; NULL = the session predates the daemon → eligible
// for the tmux attach/launch fallback gate).
//
// v6 base schema: the scalar ticket binding (`project_slug`/`assignment_slug`)
// has moved OFF `sessions` onto the `engagement` edge; `activity` (liveness) is
// added. Fresh installs get this shape directly; existing installs reach it via
// the v5→v6 migration below.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  started TEXT NOT NULL,
  ended TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  path TEXT,
  description TEXT,
  transcript_path TEXT,
  original_head_sha TEXT,
  hosted_by TEXT,
  summary TEXT,
  summarized_at TEXT,
  description_source TEXT,
  pinned_at TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
-- Every paged listing orders by started (the default sort). Without this the
-- endpoint full-scans and sorts sessions on every page request, which is the
-- cost paging exists to remove. Re-ensured after migrations run (see the tail
-- of initSessionDb) because the pre-v9 rebuild migrations DROP this table.
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

/**
 * Lease + retry state for the session summarizer, one row per session.
 *
 * Summarization is triggered by the dashboard maintenance loop and by
 * `syntaur session summarize` run by hand, and each LLM call costs money, so the
 * claim must be atomic ACROSS processes. `claim_token` makes ownership explicit:
 * release and finalization are token-matched, so a worker whose lease went stale
 * can never clobber a newer worker's claim.
 *
 * Retry state lives on disk rather than in memory because a summarize run may
 * be a fresh process — an in-memory cooldown would be invisible to it, and a
 * capped newest-first sweep would retry the same doomed sessions forever.
 *
 * Created with `CREATE TABLE IF NOT EXISTS` at init, following the
 * ENGAGEMENT_DDL precedent below: idempotent and therefore safe outside the
 * migration transaction.
 */
export const SUMMARIZE_STATE_DDL = `
CREATE TABLE IF NOT EXISTS summarize_state (
  session_id      TEXT PRIMARY KEY,
  claim_token     TEXT,
  claimed_at      TEXT,
  next_attempt_at TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT
);
`;

/**
 * Drop the five ops-subsystem tables and their meta-version rows. FK order:
 * lease_events → leases → inventory_members → inventories; artifacts is
 * independent. Idempotent (`IF EXISTS` / targeted DELETE). On SQLITE_BUSY or
 * SQLITE_LOCKED — e.g. a stale leases-db connection still open — log once and
 * return so init never fails; the next init retries.
 */
function dropRetiredTables(database: Database.Database): void {
  try {
    database.exec(`
      DROP TABLE IF EXISTS lease_events;
      DROP TABLE IF EXISTS leases;
      DROP TABLE IF EXISTS inventory_members;
      DROP TABLE IF EXISTS inventories;
      DROP TABLE IF EXISTS artifacts;
      DELETE FROM meta WHERE key IN ('proof_schema_version', 'lease_schema_version');
    `);
  } catch (err) {
    const code =
      err instanceof Error && 'code' in err
        ? (err as Error & { code: string }).code
        : undefined;
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
      console.warn(
        'dropRetiredTables: database locked by another connection; retired tables will be dropped on the next init',
      );
      return;
    }
    throw err;
  }
}

/**
 * Initialize the SQLite database for session tracking.
 * Creates the database file and schema if they don't exist.
 * @param dbPath Optional override for the database file path (used in tests).
 */
export function initSessionDb(dbPath?: string): Database.Database {
  if (db) return db;

  const finalPath = dbPath ?? resolve(syntaurRoot(), 'syntaur.db');
  db = new Database(finalPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA_SQL);
  // ENGAGEMENT_DDL / CHAT_DDL run AFTER migrations (below) so a pre-migration
  // table with assignment_id is not indexed on ticket_id before the rebuild.
  db.exec(SUMMARIZE_STATE_DDL);

  // Track schema versions. Each subsystem owns its own row in `meta`
  // (mirrors usage-db.ts) so init order is irrelevant.
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(
    'schema_version',
    SCHEMA_VERSION,
  );
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(
    'engagement_schema_version',
    ENGAGEMENT_SCHEMA_VERSION,
  );
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(
    'chat_schema_version',
    CHAT_SCHEMA_VERSION,
  );

  // Run migrations inside an EXCLUSIVE transaction. This closes two races:
  //   1. Crash between `DROP TABLE` / `RENAME` / `UPDATE meta` leaves the db
  //      half-upgraded — the transaction rolls back on failure.
  //   2. Two processes (e.g. `syntaur dashboard` + `syntaur track-session`)
  //      both calling initSessionDb() at once — EXCLUSIVE serializes the
  //      migration and the version is re-checked inside the transaction so
  //      the second process becomes a no-op once the first commits.
  // Narrow for the transaction closure — TS doesn't track the module-level
  // `db` ticket across the closure boundary.
  const database = db;
  const runMigrations = database.transaction(() => {
    // --- chat v1 → v2: `chat_sessions.last_delivered_seq` (Decision 4) ---
    // The first chat migration. `CHAT_DDL` above already declares the column
    // for a FRESH database, so the ALTER is guarded by a PRAGMA check rather
    // than by the version alone — a database created at v2 would otherwise
    // trip "duplicate column name" the first time an older row is present.
    const chatVersion = (
      database
        .prepare("SELECT value FROM meta WHERE key = 'chat_schema_version'")
        .get() as { value: string } | undefined
    )?.value;

    if (chatVersion === '1') {
      const chatColumns = (
        database.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>
      ).map((c) => c.name);
      if (!chatColumns.includes('last_delivered_seq')) {
        database.exec(
          'ALTER TABLE chat_sessions ADD COLUMN last_delivered_seq INTEGER NOT NULL DEFAULT 0',
        );
      }
      database.exec("UPDATE meta SET value = '2' WHERE key = 'chat_schema_version'");
    }

    const chatVersionAfterV2 = (
      database
        .prepare("SELECT value FROM meta WHERE key = 'chat_schema_version'")
        .get() as { value: string } | undefined
    )?.value;

    if (chatVersionAfterV2 === '2') {
      const chatColumns = (
        database.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>
      ).map((c) => c.name);
      if (!chatColumns.includes('commands_json')) {
        database.exec('ALTER TABLE chat_sessions ADD COLUMN commands_json TEXT');
      }
      database.exec("UPDATE meta SET value = '3' WHERE key = 'chat_schema_version'");
    }

    const chatVersionAfterV3 = (
      database
        .prepare("SELECT value FROM meta WHERE key = 'chat_schema_version'")
        .get() as { value: string } | undefined
    )?.value;

    if (chatVersionAfterV3 === '3') {
      database.exec(`
        CREATE TABLE IF NOT EXISTS chat_harness_options (
          harness         TEXT PRIMARY KEY,
          adapter_version TEXT,
          captured_at     TEXT,
          record_json     TEXT,
          auth_state      TEXT NOT NULL DEFAULT 'unknown',
          auth_detail     TEXT,
          auth_at         TEXT
        );
      `);
      const chatColumns = (
        database.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>
      ).map((c) => c.name);
      if (!chatColumns.includes('standing_fingerprint')) {
        database.exec('ALTER TABLE chat_sessions ADD COLUMN standing_fingerprint TEXT');
      }
      database.exec("UPDATE meta SET value = '4' WHERE key = 'chat_schema_version'");
    }

    const chatVersionAfterV4 = (
      database
        .prepare("SELECT value FROM meta WHERE key = 'chat_schema_version'")
        .get() as { value: string } | undefined
    )?.value;

    if (chatVersionAfterV4 === '4') {
      const chatColumns = (
        database.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>
      ).map((c) => c.name);
      if (!chatColumns.includes('standing_fingerprint')) {
        database.exec('ALTER TABLE chat_sessions ADD COLUMN standing_fingerprint TEXT');
      }
    }

    const chatVersionAfterV4ForV5 = (
      database
        .prepare("SELECT value FROM meta WHERE key = 'chat_schema_version'")
        .get() as { value: string } | undefined
    )?.value;

    if (chatVersionAfterV4ForV5 === '4') {
      database.exec(`
        CREATE TABLE chat_sessions_v5 (
          session_key         TEXT PRIMARY KEY,
          ticket_id           TEXT NOT NULL,
          agent_id            TEXT NOT NULL,
          harness             TEXT NOT NULL,
          acp_session_id      TEXT,
          adapter_version     TEXT,
          cwd                 TEXT,
          pid                 INTEGER,
          profile_json        TEXT,
          usage_snapshot_json TEXT,
          state               TEXT NOT NULL DEFAULT 'none',
          created_at          TEXT NOT NULL,
          last_turn_at        TEXT,
          last_delivered_seq  INTEGER NOT NULL DEFAULT 0,
          commands_json       TEXT,
          standing_fingerprint TEXT
        );
        INSERT INTO chat_sessions_v5
          SELECT session_key, assignment_id, agent_id, harness,
                 acp_session_id, adapter_version, cwd, pid, profile_json,
                 usage_snapshot_json, state, created_at, last_turn_at,
                 last_delivered_seq, commands_json, standing_fingerprint
          FROM chat_sessions;
        DROP TABLE chat_sessions;
        ALTER TABLE chat_sessions_v5 RENAME TO chat_sessions;
        CREATE INDEX IF NOT EXISTS idx_chat_sessions_ticket ON chat_sessions(ticket_id);
        CREATE INDEX IF NOT EXISTS idx_chat_sessions_acp ON chat_sessions(acp_session_id);

        CREATE TABLE chat_items_v5 (
          item_id       TEXT PRIMARY KEY,
          ticket_id     TEXT NOT NULL,
          session_key   TEXT NOT NULL,
          turn_id       TEXT,
          agent_id      TEXT NOT NULL,
          type          TEXT NOT NULL,
          ts            TEXT NOT NULL,
          seq_first     INTEGER NOT NULL,
          seq_last      INTEGER NOT NULL,
          sealed        INTEGER NOT NULL DEFAULT 0,
          json          TEXT NOT NULL
        );
        INSERT INTO chat_items_v5
          SELECT item_id, assignment_id, session_key, turn_id, agent_id, type, ts,
                 seq_first, seq_last, sealed, json
          FROM chat_items;
        DROP TABLE chat_items;
        ALTER TABLE chat_items_v5 RENAME TO chat_items;
        CREATE INDEX IF NOT EXISTS idx_chat_items_ticket_seq ON chat_items(ticket_id, seq_first);
        CREATE INDEX IF NOT EXISTS idx_chat_items_ticket_turn ON chat_items(ticket_id, turn_id);
        UPDATE meta SET value = '5' WHERE key = 'chat_schema_version';
      `);
    }

    const engagementVersion = (
      database
        .prepare("SELECT value FROM meta WHERE key = 'engagement_schema_version'")
        .get() as { value: string } | undefined
    )?.value;

    if (engagementVersion === '1') {
      database.exec(`
        CREATE TABLE engagement_v2 (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id      TEXT    NOT NULL,
          ticket_id       TEXT,
          stage           TEXT    NOT NULL DEFAULT 'implement',
          started_at      TEXT    NOT NULL,
          ended_at        TEXT,
          tokens_at_open  TEXT,
          tokens_at_close TEXT,
          close_reason    TEXT
        );
        INSERT INTO engagement_v2
          SELECT id, session_id, assignment_id, stage, started_at, ended_at,
                 tokens_at_open, tokens_at_close, close_reason
          FROM engagement;
        DROP TABLE engagement;
        ALTER TABLE engagement_v2 RENAME TO engagement;
        CREATE UNIQUE INDEX IF NOT EXISTS one_active_per_session
          ON engagement(session_id) WHERE ended_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_engagement_session ON engagement(session_id);
        CREATE INDEX IF NOT EXISTS idx_engagement_ticket ON engagement(ticket_id);
        UPDATE meta SET value = '2' WHERE key = 'engagement_schema_version';
      `);
    }

    // --- v1 → v2: make project/ticket nullable, add description ---
    const vBeforeV2 = (
      database
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined
    )?.value;

    if (vBeforeV2 === '1') {
      database.exec(`
        CREATE TABLE sessions_v2 (
          session_id TEXT PRIMARY KEY,
          project_slug TEXT,
          assignment_slug TEXT,
          agent TEXT NOT NULL,
          started TEXT NOT NULL,
          ended TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          path TEXT,
          description TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO sessions_v2 SELECT session_id, project_slug, assignment_slug, agent, started, ended, status, path, NULL, created_at, updated_at FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_v2 RENAME TO sessions;
        CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_slug);
        CREATE INDEX IF NOT EXISTS idx_sessions_ticket ON sessions(project_slug, assignment_slug);
        CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
        UPDATE meta SET value = '2' WHERE key = 'schema_version';
      `);
    }

    // --- v2 → v3: add transcript_path, normalize legacy mission_slug ---
    // Re-read the version AFTER v1→v2 may have run.
    const vBeforeV3 = (
      database
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined
    )?.value;

    if (vBeforeV3 === '2') {
      const v2Columns = database
        .prepare('PRAGMA table_info(sessions)')
        .all() as Array<{ name: string }>;
      const v2ColNames = v2Columns.map((c) => c.name);
      const hasProject = v2ColNames.includes('project_slug');
      const hasMission = v2ColNames.includes('mission_slug');

      // If a db somehow has both columns (e.g. a partially-renamed table),
      // prefer project_slug but fall back to mission_slug so rows that only
      // populated mission_slug aren't dropped.
      const projectSlugExpr =
        hasProject && hasMission
          ? 'COALESCE(project_slug, mission_slug)'
          : hasProject
            ? 'project_slug'
            : hasMission
              ? 'mission_slug'
              : null;

      if (!projectSlugExpr) {
        throw new Error(
          'sessions table has neither project_slug nor mission_slug; cannot migrate from v2 to v3',
        );
      }

      database.exec(`
        CREATE TABLE sessions_v3 (
          session_id TEXT PRIMARY KEY,
          project_slug TEXT,
          assignment_slug TEXT,
          agent TEXT NOT NULL,
          started TEXT NOT NULL,
          ended TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          path TEXT,
          description TEXT,
          transcript_path TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO sessions_v3
          SELECT session_id, ${projectSlugExpr}, assignment_slug, agent, started, ended, status, path, description, NULL, created_at, updated_at
          FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_v3 RENAME TO sessions;
        CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_slug);
        CREATE INDEX IF NOT EXISTS idx_sessions_ticket ON sessions(project_slug, assignment_slug);
        CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
        UPDATE meta SET value = '3' WHERE key = 'schema_version';
      `);
    }

    // --- v3 → v4: add pid + pid_started_at for liveness detection ---
    const vBeforeV4 = (
      database
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined
    )?.value;

    if (vBeforeV4 === '3') {
      database.exec(`
        CREATE TABLE sessions_v4 (
          session_id TEXT PRIMARY KEY,
          project_slug TEXT,
          assignment_slug TEXT,
          agent TEXT NOT NULL,
          started TEXT NOT NULL,
          ended TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          path TEXT,
          description TEXT,
          transcript_path TEXT,
          pid INTEGER,
          pid_started_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO sessions_v4
          SELECT session_id, project_slug, assignment_slug, agent, started, ended, status, path, description, transcript_path, NULL, NULL, created_at, updated_at
          FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_v4 RENAME TO sessions;
        CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_slug);
        CREATE INDEX IF NOT EXISTS idx_sessions_ticket ON sessions(project_slug, assignment_slug);
        CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
        UPDATE meta SET value = '4' WHERE key = 'schema_version';
      `);
    }

    // --- v4 → v5: add original_head_sha for exact worktree recreation ---
    const vBeforeV5 = (
      database
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined
    )?.value;

    if (vBeforeV5 === '4') {
      database.exec(`
        CREATE TABLE sessions_v5 (
          session_id TEXT PRIMARY KEY,
          project_slug TEXT,
          assignment_slug TEXT,
          agent TEXT NOT NULL,
          started TEXT NOT NULL,
          ended TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          path TEXT,
          description TEXT,
          transcript_path TEXT,
          pid INTEGER,
          pid_started_at TEXT,
          original_head_sha TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO sessions_v5
          SELECT session_id, project_slug, assignment_slug, agent, started, ended, status, path, description, transcript_path, pid, pid_started_at, NULL, created_at, updated_at
          FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_v5 RENAME TO sessions;
        CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_slug);
        CREATE INDEX IF NOT EXISTS idx_sessions_ticket ON sessions(project_slug, assignment_slug);
        CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
        UPDATE meta SET value = '5' WHERE key = 'schema_version';
      `);
    }

    // --- v5 → v6: move the scalar ticket binding onto the engagement edge
    // and add the `activity` liveness column — ONE migration. Order matters:
    // create engagement, backfill from the still-present slug columns, THEN drop
    // them. All inside this EXCLUSIVE transaction so it is crash-atomic.
    const vBeforeV6 = (
      database
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined
    )?.value;

    if (vBeforeV6 === '5') {
      database.exec(ENGAGEMENT_DDL); // idempotent; may already exist from init
      const counts = backfillEngagements(database);
      database.exec(`
        CREATE TABLE sessions_v6 (
          session_id TEXT PRIMARY KEY,
          agent TEXT NOT NULL,
          started TEXT NOT NULL,
          ended TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          path TEXT,
          description TEXT,
          transcript_path TEXT,
          pid INTEGER,
          pid_started_at TEXT,
          original_head_sha TEXT,
          activity TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO sessions_v6
          SELECT session_id, agent, started, ended, status, path, description,
                 transcript_path, pid, pid_started_at, original_head_sha, NULL,
                 created_at, updated_at
          FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_v6 RENAME TO sessions;
        CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
        UPDATE meta SET value = '6' WHERE key = 'schema_version';
      `);
      console.log(
        `engagement backfill: backfilled=${counts.backfilled} attributed=${counts.attributed} unattributed=${counts.unattributed}`,
      );
    }

    // --- v6 → v7: add hosted_by (which backend hosts the live PTY:
    // 'syntaurd' | 'tmux'; NULL = predates the daemon → tmux-gate eligible).
    // Table-rebuild like every step above — never ALTER TABLE ADD COLUMN.
    const vBeforeV7 = (
      database
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined
    )?.value;

    if (vBeforeV7 === '6') {
      database.exec(`
        CREATE TABLE sessions_v7 (
          session_id TEXT PRIMARY KEY,
          agent TEXT NOT NULL,
          started TEXT NOT NULL,
          ended TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          path TEXT,
          description TEXT,
          transcript_path TEXT,
          pid INTEGER,
          pid_started_at TEXT,
          original_head_sha TEXT,
          activity TEXT,
          hosted_by TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO sessions_v7
          SELECT session_id, agent, started, ended, status, path, description,
                 transcript_path, pid, pid_started_at, original_head_sha, activity,
                 NULL, created_at, updated_at
          FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_v7 RENAME TO sessions;
        CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
        UPDATE meta SET value = '7' WHERE key = 'schema_version';
      `);
    }

    // --- v7 → v8: add the auto-summary columns (`summary`, `summarized_at`,
    // `description_source`) and seed provenance. Table-rebuild like every step
    // above — never ALTER TABLE ADD COLUMN.
    //
    // Two backfills ride the same transaction:
    //   1. Every existing non-empty description predates the summarizer, and
    //      every current writer (POST body, track-session) is caller-set, so
    //      they are all stamped 'human' — the summarizer must never overwrite
    //      one.
    //   2. `path = '/'` rows are cleared. Investigation showed those sessions
    //      genuinely ran at filesystem root (headless ping-style transcripts
    //      record cwd:"/" throughout); NULL is honest about an unknown cwd
    //      where '/' actively misleads. See sanitizeSessionPath.
    const vBeforeV8 = (
      database
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined
    )?.value;

    if (vBeforeV8 === '7') {
      database.exec(`
        CREATE TABLE sessions_v8 (
          session_id TEXT PRIMARY KEY,
          agent TEXT NOT NULL,
          started TEXT NOT NULL,
          ended TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          path TEXT,
          description TEXT,
          transcript_path TEXT,
          pid INTEGER,
          pid_started_at TEXT,
          original_head_sha TEXT,
          activity TEXT,
          hosted_by TEXT,
          summary TEXT,
          summarized_at TEXT,
          description_source TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO sessions_v8
          SELECT session_id, agent, started, ended, status, path, description,
                 transcript_path, pid, pid_started_at, original_head_sha, activity,
                 hosted_by, NULL, NULL, NULL, created_at, updated_at
          FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_v8 RENAME TO sessions;
        CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
        UPDATE sessions SET description_source = 'human'
          WHERE description IS NOT NULL AND description != '';
        UPDATE sessions SET path = NULL WHERE path = '/';
        ${SUMMARIZE_STATE_DDL}
        UPDATE meta SET value = '8' WHERE key = 'schema_version';
      `);
    }

    // --- v8 → v9: launch_reservations (pending-launch reservation, Phase C).
    // A NEW table — no sessions rebuild; the version-gated CREATE IF NOT EXISTS
    // is idempotent and crash-atomic inside the exclusive transaction.
    const vBeforeV9 = (
      database
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined
    )?.value;

    if (vBeforeV9 === '8') {
      database.exec(`
        CREATE TABLE IF NOT EXISTS launch_reservations (
          launch_id TEXT PRIMARY KEY,
          hosted_by TEXT NOT NULL,
          agent TEXT,
          cwd TEXT,
          expected_session_id TEXT,
          created_at TEXT NOT NULL,
          dispatched_at TEXT,
          claimed_by TEXT,
          claimed_at TEXT,
          canceled_at TEXT
        );
        UPDATE meta SET value = '9' WHERE key = 'schema_version';
      `);
    }

    // --- v9 → v10: add the curation flags (`pinned_at`, `archived_at`).
    // Table-rebuild like every step above — never ALTER TABLE ADD COLUMN.
    //
    // The copy is POSITIONAL: the 16 v9 payload columns in order, then
    // NULL, NULL for the two new flags, then the created_at/updated_at
    // audit pair. A slip mis-assigns data silently rather than erroring,
    // so session-db-migration-v10.test.ts asserts PRAGMA table_info order
    // with toEqual and seeds a distinct value in every payload column.
    //
    // Note this rebuild also drops `idx_sessions_started` (added alongside
    // paging). It is NOT recreated here: the tail of initSessionDb re-ensures
    // it after all migrations run, which is the mechanism that already covers
    // every earlier rebuild. The v10 migration test asserts it survives.
    const vBeforeV10 = (
      database
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined
    )?.value;

    if (vBeforeV10 === '9') {
      database.exec(`
        CREATE TABLE sessions_v10 (
          session_id TEXT PRIMARY KEY,
          agent TEXT NOT NULL,
          started TEXT NOT NULL,
          ended TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          path TEXT,
          description TEXT,
          transcript_path TEXT,
          pid INTEGER,
          pid_started_at TEXT,
          original_head_sha TEXT,
          activity TEXT,
          hosted_by TEXT,
          summary TEXT,
          summarized_at TEXT,
          description_source TEXT,
          pinned_at TEXT,
          archived_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO sessions_v10
          SELECT session_id, agent, started, ended, status, path, description,
                 transcript_path, pid, pid_started_at, original_head_sha, activity,
                 hosted_by, summary, summarized_at, description_source,
                 NULL, NULL, created_at, updated_at
          FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_v10 RENAME TO sessions;
        CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
        UPDATE meta SET value = '10' WHERE key = 'schema_version';
      `);
    }

    // --- v10 → v11: drop everything the terminal-launch stack owned.
    //
    // The `launch_reservations` table goes outright — its only readers were
    // `reserveLaunch` / `claimLaunch` / `consumeLaunchMarkers`, all deleted.
    //
    // `sessions` is rebuilt without `pid`, `pid_started_at` and `activity`.
    // Each was WRITTEN (`appendSession`, the register routes) but READ only by
    // code that is gone: `computeIsLive`'s pid + start-time guard
    // (`session-liveness.ts`, deleted in Task 3), the transcript scanner's
    // `SELECT session_id, pid, pid_started_at, ...` liveness query and the
    // Agent View's `activity` join (both deleted in Task 4), and
    // `reconcileLaunchPlaceholder`'s `pid = COALESCE(...)` copy (deleted with
    // the reservations). `transcript_path` is KEPT — a dozen readers outside
    // the scanner still use it.
    //
    // The copy is POSITIONAL, like every step above. `hosted_by` is copied as
    // `CASE WHEN hosted_by = 'acp' THEN 'acp' ELSE NULL END`, so historical
    // `syntaurd` / `tmux` / `claude-bg` rows become NULL and the TypeScript
    // union `'acp' | null` matches what is actually in the table.
    const vBeforeV11 = (
      database
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined
    )?.value;

    if (vBeforeV11 === '10') {
      database.exec(`
        CREATE TABLE sessions_v11 (
          session_id TEXT PRIMARY KEY,
          agent TEXT NOT NULL,
          started TEXT NOT NULL,
          ended TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          path TEXT,
          description TEXT,
          transcript_path TEXT,
          original_head_sha TEXT,
          hosted_by TEXT,
          summary TEXT,
          summarized_at TEXT,
          description_source TEXT,
          pinned_at TEXT,
          archived_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO sessions_v11
          SELECT session_id, agent, started, ended, status, path, description,
                 transcript_path, original_head_sha,
                 CASE WHEN hosted_by = 'acp' THEN 'acp' ELSE NULL END,
                 summary, summarized_at, description_source,
                 pinned_at, archived_at, created_at, updated_at
          FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_v11 RENAME TO sessions;
        CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
        DROP TABLE IF EXISTS launch_reservations;
        UPDATE meta SET value = '11' WHERE key = 'schema_version';
      `);
    }

    // --- v11 → v12: drop the lease, inventory and artifact subsystems.
    // Same DROP/DELETE as `dropRetiredTables()` — the versioned step handles
    // databases upgrading from v11; the unconditional call after migrations
    // catches tables recreated by a stale CLI on an already-v12 database.
    const vBeforeV12 = (
      database
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined
    )?.value;

    if (vBeforeV12 === '11') {
      dropRetiredTables(database);
      database.exec("UPDATE meta SET value = '12' WHERE key = 'schema_version'");
    }
  });
  runMigrations.exclusive();

  db.exec(ENGAGEMENT_DDL);
  db.exec(CHAT_DDL);

  dropRetiredTables(db);

  // Indexes, re-ensured AFTER migrations. SCHEMA_SQL runs before them, and the
  // pre-v9 migrations rebuild `sessions` via CREATE/INSERT/DROP/RENAME — which
  // silently drops any index SCHEMA_SQL just created. Each of those migrations
  // recreates `idx_sessions_status` inline, so a database upgrading from an old
  // version would otherwise arrive at v9 without `idx_sessions_started`.
  // Idempotent, so running it on every init is free.
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started);');

  // Pinned-first paging indexes. Same placement and reasoning as the line above,
  // and doubly required here: `pinned_at` / `archived_at` do not exist until the
  // v9→v10 migration has run, so these CANNOT live in SCHEMA_SQL (which executes
  // BEFORE migrations, against a table that may still be v9-shaped).
  //
  // Why they exist: the paged list orders by
  //   pinned_at IS NULL, pinned_at DESC, started <dir>, session_id
  // and `idx_sessions_started` cannot satisfy that leading pin term. Without
  // these, EXPLAIN QUERY PLAN degrades from
  //   SCAN s USING INDEX idx_sessions_started   ->   SCAN s
  // i.e. every page full-scans and sorts the whole table, defeating the point of
  // server-side paging. Measured on a 3000-row fixture; these restore the index
  // scan for both started directions.
  //
  // PARTIAL on `archived_at IS NULL` because that is the default view and
  // carries essentially all traffic. The Shown / Archived-only views fall back
  // to a scan, which is the right trade: they are deliberate, rare, and a full
  // index would tax every write to serve them.
  //
  // Only the two `started` sorts are covered. `ticket_asc` / `agent_asc`
  // order on joined engagement columns and were ALREADY unindexed before this
  // change, so the pin prefix costs them nothing.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_pinned_started_desc
      ON sessions((pinned_at IS NULL), pinned_at DESC, started DESC, session_id)
      WHERE archived_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_sessions_pinned_started_asc
      ON sessions((pinned_at IS NULL), pinned_at DESC, started ASC, session_id)
      WHERE archived_at IS NULL;

    -- The mirror pair for the Archived-only view. Cheap: a partial index over
    -- archived rows only, which is by nature a small slice — archiving is what
    -- you do to get things OUT of the way. This is also the view you land on to
    -- unarchive, so it is worth keeping index-driven.
    CREATE INDEX IF NOT EXISTS idx_sessions_archived_pinned_started_desc
      ON sessions((pinned_at IS NULL), pinned_at DESC, started DESC, session_id)
      WHERE archived_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_sessions_archived_pinned_started_asc
      ON sessions((pinned_at IS NULL), pinned_at DESC, started ASC, session_id)
      WHERE archived_at IS NOT NULL;
  `);

  // NOT indexed: the `archived: 'show'` view, which applies no archived
  // predicate at all and so matches neither partial index. Covering it needs
  // FULL indexes over the whole table in both directions — doubling the write
  // cost of every session upsert to serve the one view that deliberately asks
  // for everything at once, and is reached far less often than the default.
  // Left as a scan on purpose; revisit if that view ever becomes hot.

  return db;
}

/** True once initSessionDb() has run (and the handle wasn't closed/reset). */
export function isSessionDbInitialized(): boolean {
  return db !== null;
}

/**
 * Get the initialized database handle.
 * Throws if initSessionDb() has not been called.
 */
export function getSessionDb(): Database.Database {
  if (!db) {
    throw new Error(
      'Session database not initialized. Call initSessionDb() first.',
    );
  }
  return db;
}

/**
 * Close the database connection.
 */
export function closeSessionDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Reset the singleton for testing purposes.
 */
export function resetSessionDb(): void {
  db = null;
}

/**
 * One-time migration: import sessions from markdown _index-sessions.md files into SQLite.
 * Only runs if the sessions table is empty and markdown files exist.
 */
export async function migrateFromMarkdown(projectsDir: string): Promise<number> {
  const database = getSessionDb();

  // Skip if sessions already exist in the database
  const count = database.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
  if (count.count > 0) return 0;

  if (!(await fileExists(projectsDir))) return 0;

  const entries = await readdir(projectsDir, { withFileTypes: true });
  const allSessions: AgentSession[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectDir = resolve(projectsDir, entry.name);
    const indexPath = resolve(projectDir, '_index-sessions.md');
    if (!(await fileExists(indexPath))) continue;

    const sessions = await parseMarkdownSessionsIndex(indexPath, entry.name);
    allSessions.push(...sessions);
  }

  if (allSessions.length === 0) return 0;

  // v6: `sessions` no longer carries the scalar binding. Insert the session row
  // without slugs, then record the binding as an engagement edge. Raw INSERT
  // (not engagement-db's helper) to avoid a session-db ↔ engagement-db cycle.
  const insert = database.prepare(`
    INSERT OR IGNORE INTO sessions (session_id, agent, started, status, path)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertEngagement = database.prepare(`
    INSERT INTO engagement (session_id, ticket_id, stage, started_at, ended_at, close_reason)
    SELECT @sid, @ticketId, 'implement', @started, @ended, @reason
     WHERE NOT EXISTS (
       SELECT 1 FROM engagement WHERE session_id = @sid AND ended_at IS NULL
     )
  `);

  const insertAll = database.transaction((sessions: AgentSession[]) => {
    for (const s of sessions) {
      // Only attach an engagement to the session row that actually persisted:
      // a duplicate session_id is IGNORED here, so its (possibly different)
      // status must not drive an engagement onto the row that already won.
      // This legacy importer inserts directly (not via appendSession), so it
      // must apply the same degenerate-path guard — otherwise a markdown row
      // carrying path='/' would reintroduce the value the v8 backfill removed.
      const res = insert.run(
        s.sessionId,
        s.agent,
        s.started,
        s.status,
        sanitizeSessionPath(s.path) ?? '',
      );
      if (res.changes > 0 && (s.ticketId || s.ticketSlug)) {
        // Terminal imports become CLOSED engagements (no leaked open interval);
        // markdown has no `ended` timestamp, so fall back to `started`.
        const terminal = s.status === 'completed' || s.status === 'stopped';
        insertEngagement.run({
          sid: s.sessionId,
          ticketId: s.ticketId ?? s.ticketSlug ?? null,
          started: s.started,
          ended: terminal ? s.started : null,
          reason: terminal ? (s.status === 'completed' ? 'completed' : 'abandoned') : null,
        });
      }
    }
  });

  insertAll(allSessions);
  console.log(`Migrated ${allSessions.length} sessions from markdown to SQLite.`);
  return allSessions.length;
}

/**
 * Parse an _index-sessions.md file into AgentSession objects.
 * Used only for one-time migration. This is a copy of the old parsing logic.
 */
async function parseMarkdownSessionsIndex(
  filePath: string,
  projectSlug: string,
): Promise<AgentSession[]> {
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(filePath, 'utf-8');
  const sessions: AgentSession[] = [];

  const lines = raw.split('\n');
  let inTable = false;
  let headerSeen = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (
      trimmed.startsWith('| Ticket') ||
      trimmed.startsWith('|Ticket') ||
      trimmed.startsWith('| Assignment') ||
      trimmed.startsWith('|Assignment')
    ) {
      inTable = true;
      headerSeen = false;
      continue;
    }

    if (inTable && !headerSeen && trimmed.match(/^\|[-\s|]+\|$/)) {
      headerSeen = true;
      continue;
    }

    if (inTable && headerSeen && trimmed.startsWith('|')) {
      const cells = trimmed
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim());

      if (cells.length >= 6) {
        sessions.push({
          ticketSlug: cells[0],
          agent: cells[1],
          sessionId: cells[2],
          started: cells[3],
          status: (cells[4] as AgentSessionStatus) || 'active',
          path: cells[5],
          projectSlug,
        });
      }
    }
  }

  return sessions;
}
