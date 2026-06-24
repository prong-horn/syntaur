import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { syntaurRoot } from '../utils/paths.js';
import { fileExists } from '../utils/fs.js';
import type { AgentSession, AgentSessionStatus } from './types.js';
import { ENGAGEMENT_DDL, ENGAGEMENT_SCHEMA_VERSION } from '../db/engagement-schema.js';
import { backfillEngagements } from '../db/engagement-backfill.js';

let db: Database.Database | null = null;

const SCHEMA_VERSION = '6';

// v6 base schema: the scalar assignment binding (`project_slug`/`assignment_slug`)
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
  pid INTEGER,
  pid_started_at TEXT,
  original_head_sha TEXT,
  activity TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

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
  db.exec(SCHEMA_SQL);
  // The engagement edge table (session↔assignment M:N). Idempotent
  // `CREATE TABLE IF NOT EXISTS`, so it is safe to run here — outside the
  // migration transaction — on the same footing as the base session tables.
  // The v5→v6 migration also runs this (harmlessly) before backfilling.
  db.exec(ENGAGEMENT_DDL);

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

  // Run migrations inside an EXCLUSIVE transaction. This closes two races:
  //   1. Crash between `DROP TABLE` / `RENAME` / `UPDATE meta` leaves the db
  //      half-upgraded — the transaction rolls back on failure.
  //   2. Two processes (e.g. `syntaur dashboard` + `syntaur track-session`)
  //      both calling initSessionDb() at once — EXCLUSIVE serializes the
  //      migration and the version is re-checked inside the transaction so
  //      the second process becomes a no-op once the first commits.
  // Narrow for the transaction closure — TS doesn't track the module-level
  // `db` assignment across the closure boundary.
  const database = db;
  const runMigrations = database.transaction(() => {
    // --- v1 → v2: make project/assignment nullable, add description ---
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
        CREATE INDEX IF NOT EXISTS idx_sessions_assignment ON sessions(project_slug, assignment_slug);
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
        CREATE INDEX IF NOT EXISTS idx_sessions_assignment ON sessions(project_slug, assignment_slug);
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
        CREATE INDEX IF NOT EXISTS idx_sessions_assignment ON sessions(project_slug, assignment_slug);
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
        CREATE INDEX IF NOT EXISTS idx_sessions_assignment ON sessions(project_slug, assignment_slug);
        CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
        UPDATE meta SET value = '5' WHERE key = 'schema_version';
      `);
    }

    // --- v5 → v6: move the scalar assignment binding onto the engagement edge
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
  });
  runMigrations.exclusive();

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
    INSERT INTO engagement (session_id, project_slug, assignment_slug, stage, started_at, ended_at, close_reason)
    SELECT @sid, @ps, @as, 'implement', @started, @ended, @reason
     WHERE NOT EXISTS (
       SELECT 1 FROM engagement WHERE session_id = @sid AND ended_at IS NULL
     )
  `);

  const insertAll = database.transaction((sessions: AgentSession[]) => {
    for (const s of sessions) {
      // Only attach an engagement to the session row that actually persisted:
      // a duplicate session_id is IGNORED here, so its (possibly different)
      // status must not drive an engagement onto the row that already won.
      const res = insert.run(s.sessionId, s.agent, s.started, s.status, s.path);
      if (res.changes > 0 && (s.projectSlug || s.assignmentSlug)) {
        // Terminal imports become CLOSED engagements (no leaked open interval);
        // markdown has no `ended` timestamp, so fall back to `started`.
        const terminal = s.status === 'completed' || s.status === 'stopped';
        insertEngagement.run({
          sid: s.sessionId,
          ps: s.projectSlug ?? null,
          as: s.assignmentSlug ?? null,
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

    if (trimmed.startsWith('| Assignment') || trimmed.startsWith('|Assignment')) {
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
          assignmentSlug: cells[0],
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
