import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { syntaurRoot } from '../utils/paths.js';
import { fileExists } from '../utils/fs.js';
import type { AgentSession, AgentSessionStatus } from './types.js';

let db: Database.Database | null = null;

const SCHEMA_VERSION = '2';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  mission_slug TEXT,
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
CREATE INDEX IF NOT EXISTS idx_sessions_mission ON sessions(mission_slug);
CREATE INDEX IF NOT EXISTS idx_sessions_assignment ON sessions(mission_slug, assignment_slug);
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

  // Track schema version
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(
    'schema_version',
    SCHEMA_VERSION,
  );

  // Migrate from v1 to v2: make mission/assignment nullable, add description
  const currentVersion = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;

  if (currentVersion?.value === '1') {
    db.exec(`
      CREATE TABLE sessions_v2 (
        session_id TEXT PRIMARY KEY,
        mission_slug TEXT,
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
      INSERT INTO sessions_v2 SELECT session_id, mission_slug, assignment_slug, agent, started, ended, status, path, NULL, created_at, updated_at FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_v2 RENAME TO sessions;
      CREATE INDEX IF NOT EXISTS idx_sessions_mission ON sessions(mission_slug);
      CREATE INDEX IF NOT EXISTS idx_sessions_assignment ON sessions(mission_slug, assignment_slug);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      UPDATE meta SET value = '2' WHERE key = 'schema_version';
    `);
  }

  return db;
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
export async function migrateFromMarkdown(missionsDir: string): Promise<number> {
  const database = getSessionDb();

  // Skip if sessions already exist in the database
  const count = database.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
  if (count.count > 0) return 0;

  if (!(await fileExists(missionsDir))) return 0;

  const entries = await readdir(missionsDir, { withFileTypes: true });
  const allSessions: AgentSession[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const missionDir = resolve(missionsDir, entry.name);
    const indexPath = resolve(missionDir, '_index-sessions.md');
    if (!(await fileExists(indexPath))) continue;

    const sessions = await parseMarkdownSessionsIndex(indexPath, entry.name);
    allSessions.push(...sessions);
  }

  if (allSessions.length === 0) return 0;

  const insert = database.prepare(`
    INSERT OR IGNORE INTO sessions (session_id, mission_slug, assignment_slug, agent, started, status, path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAll = database.transaction((sessions: AgentSession[]) => {
    for (const s of sessions) {
      insert.run(s.sessionId, s.missionSlug, s.assignmentSlug, s.agent, s.started, s.status, s.path);
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
  missionSlug: string,
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
          missionSlug,
        });
      }
    }
  }

  return sessions;
}
