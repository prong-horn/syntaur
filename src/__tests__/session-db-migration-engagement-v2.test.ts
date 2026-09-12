import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
  getSessionDb,
} from '../dashboard/session-db.js';

const HEAD_ENGAGEMENT_COLUMNS = [
  'id',
  'session_id',
  'ticket_id',
  'stage',
  'started_at',
  'ended_at',
  'tokens_at_open',
  'tokens_at_close',
  'close_reason',
];

const TICKET_UUID = '99999999-9999-4999-8999-999999999999';

let testDir: string;
let dbPath: string;
let prevHome: string | undefined;

function engagementSchemaVersion(): string {
  return (
    getSessionDb()
      .prepare("SELECT value FROM meta WHERE key='engagement_schema_version'")
      .get() as { value: string }
  ).value;
}

function columns(): string[] {
  return (
    getSessionDb().prepare('PRAGMA table_info(engagement)').all() as Array<{ name: string }>
  ).map((c) => c.name);
}

function buildV1EngagementDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE sessions (
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
    CREATE TABLE engagement (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      assignment_id TEXT,
      project_slug TEXT,
      assignment_slug TEXT,
      stage TEXT NOT NULL DEFAULT 'implement',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      tokens_at_open TEXT,
      tokens_at_close TEXT,
      close_reason TEXT
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta (key, value) VALUES ('schema_version', '12');
    INSERT INTO meta (key, value) VALUES ('engagement_schema_version', '1');
    INSERT INTO meta (key, value) VALUES ('chat_schema_version', '5');
  `);
  db.prepare(
    `INSERT INTO engagement
       (session_id, assignment_id, project_slug, assignment_slug, stage, started_at, ended_at, close_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'sess-1',
    TICKET_UUID,
    'proj-a',
    'asg-1',
    'implement',
    '2026-08-01T10:00:00.000Z',
    null,
    null,
  );
  db.close();
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-eng-v2-mig-'));
  dbPath = resolve(testDir, 'syntaur.db');
  prevHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = resolve(testDir, 'home');
  resetSessionDb();
});

afterEach(async () => {
  closeSessionDb();
  if (prevHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = prevHome;
  await rm(testDir, { recursive: true, force: true });
});

describe('engagement v1 → v2 migration (assignment_id → ticket_id, drop slugs)', () => {
  it('preserves row values and column order, bumps engagement_schema_version to 2', () => {
    buildV1EngagementDb(dbPath);
    initSessionDb(dbPath);

    expect(columns()).toEqual(HEAD_ENGAGEMENT_COLUMNS);
    expect(engagementSchemaVersion()).toBe('2');

    const row = getSessionDb()
      .prepare('SELECT * FROM engagement WHERE session_id = ?')
      .get('sess-1') as Record<string, unknown>;
    expect(row.ticket_id).toBe(TICKET_UUID);
    expect(row.project_slug).toBeUndefined();
    expect(row.assignment_slug).toBeUndefined();
    expect(row.stage).toBe('implement');
    expect(row.started_at).toBe('2026-08-01T10:00:00.000Z');
  });

  it('fresh install has head engagement shape at v2', () => {
    initSessionDb(dbPath);
    expect(columns()).toEqual(HEAD_ENGAGEMENT_COLUMNS);
    expect(engagementSchemaVersion()).toBe('2');
  });
});
