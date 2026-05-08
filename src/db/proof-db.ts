import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { syntaurRoot } from '../utils/paths.js';

let db: Database.Database | null = null;

const PROOF_SCHEMA_VERSION = '1';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL,
  assignment_dir TEXT NOT NULL,
  criterion_index INTEGER,
  kind TEXT NOT NULL,
  file_path TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_artifacts_assignment ON artifacts(assignment_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_assignment_criterion ON artifacts(assignment_id, criterion_index);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

export type ArtifactKind = 'screenshot' | 'video' | 'asciinema' | 'http' | 'text';

export interface ArtifactRow {
  id: string;
  assignment_id: string;
  assignment_dir: string;
  criterion_index: number | null;
  kind: ArtifactKind;
  file_path: string | null;
  note: string | null;
  created_at: string;
}

export interface InsertArtifactInput {
  id: string;
  assignmentId: string;
  assignmentDir: string;
  criterionIndex: number | null;
  kind: ArtifactKind;
  filePath: string | null;
  note: string | null;
}

/**
 * Initialize the proof artifacts database. Shares the same `~/.syntaur/syntaur.db`
 * file as `session-db.ts` but owns its own `proof_schema_version` meta row so
 * the two can coexist. Mirrors the singleton + WAL + exclusive-migration
 * pattern from `src/dashboard/session-db.ts`.
 */
export function initProofDb(dbPath?: string): Database.Database {
  if (db) return db;

  const finalPath = dbPath ?? resolve(syntaurRoot(), 'syntaur.db');
  db = new Database(finalPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);

  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(
    'proof_schema_version',
    PROOF_SCHEMA_VERSION,
  );

  // No migrations yet for v1, but run an exclusive transaction to set the
  // pattern for v2+ (mirrors session-db.ts).
  const database = db;
  const runMigrations = database.transaction(() => {
    // future migrations go here
  });
  runMigrations.exclusive();

  return db;
}

export function getProofDb(): Database.Database {
  if (!db) {
    throw new Error('Proof database not initialized. Call initProofDb() first.');
  }
  return db;
}

export function closeProofDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function resetProofDb(): void {
  db = null;
}

export function insertArtifact(input: InsertArtifactInput): void {
  const database = getProofDb();
  database
    .prepare(
      `INSERT INTO artifacts (id, assignment_id, assignment_dir, criterion_index, kind, file_path, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.assignmentId,
      input.assignmentDir,
      input.criterionIndex,
      input.kind,
      input.filePath,
      input.note,
    );
}

/**
 * List all artifacts for an assignment, ordered with tagged criteria first
 * (ascending by index) and untagged last, then by creation time.
 */
export function listArtifactsByAssignment(assignmentId: string): ArtifactRow[] {
  const database = getProofDb();
  const rows = database
    .prepare(
      `SELECT id, assignment_id, assignment_dir, criterion_index, kind, file_path, note, created_at
       FROM artifacts
       WHERE assignment_id = ?
       ORDER BY (criterion_index IS NULL), criterion_index, created_at`,
    )
    .all(assignmentId) as ArtifactRow[];
  return rows;
}

/**
 * Lookup a single artifact by id (helpful for collision detection at the DB
 * layer; the capture command does its own uniqueness check before insert).
 */
export function getArtifactById(id: string): ArtifactRow | null {
  const database = getProofDb();
  const row = database
    .prepare(
      `SELECT id, assignment_id, assignment_dir, criterion_index, kind, file_path, note, created_at
       FROM artifacts
       WHERE id = ?`,
    )
    .get(id) as ArtifactRow | undefined;
  return row ?? null;
}
