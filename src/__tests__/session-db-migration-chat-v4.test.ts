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

const LEGACY_CHAT_V3_DDL = `
CREATE TABLE IF NOT EXISTS chat_sessions (
  session_key         TEXT PRIMARY KEY,
  assignment_id       TEXT NOT NULL,
  project_slug        TEXT,
  assignment_slug     TEXT,
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
  commands_json       TEXT
);
CREATE TABLE IF NOT EXISTS chat_items (
  item_id       TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL,
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
`;

let testDir: string;
let dbPath: string;
let prevHome: string | undefined;

function chatSchemaVersion(): string {
  return (
    getSessionDb()
      .prepare("SELECT value FROM meta WHERE key='chat_schema_version'")
      .get() as { value: string }
  ).value;
}

function buildV3ChatDb(path: string): void {
  const db = new Database(path);
  // v3 chat DDL without chat_harness_options.
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta (key, value) VALUES ('chat_schema_version', '3');
    INSERT INTO meta (key, value) VALUES ('schema_version', '11');
    INSERT INTO meta (key, value) VALUES ('engagement_schema_version', '2');
  `);
  db.exec(LEGACY_CHAT_V3_DDL);
  db.close();
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-chat-v4-mig-'));
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

describe('chat schema v3 → v4 migration', () => {
  it('creates chat_harness_options and bumps chat_schema_version to 4', () => {
    buildV3ChatDb(dbPath);
    initSessionDb(dbPath);

    const table = getSessionDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_harness_options'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe('chat_harness_options');
    expect(chatSchemaVersion()).toBe('5');
    const columns = (
      getSessionDb().prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toContain('standing_fingerprint');
  });

  it('adds standing_fingerprint when reopening a v4 db that predates the column', () => {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta (key, value) VALUES ('chat_schema_version', '4');
      INSERT INTO meta (key, value) VALUES ('schema_version', '11');
      INSERT INTO meta (key, value) VALUES ('engagement_schema_version', '2');
    `);
    db.exec(`
    CREATE TABLE chat_sessions (
      session_key TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL,
      project_slug TEXT,
      assignment_slug TEXT,
      agent_id TEXT NOT NULL,
      harness TEXT NOT NULL,
      acp_session_id TEXT,
      adapter_version TEXT,
      cwd TEXT,
      pid INTEGER,
      profile_json TEXT,
      usage_snapshot_json TEXT,
      state TEXT NOT NULL DEFAULT 'none',
      created_at TEXT NOT NULL,
      last_turn_at TEXT,
      last_delivered_seq INTEGER NOT NULL DEFAULT 0,
      commands_json TEXT
    );
      CREATE TABLE chat_items (
        item_id TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        turn_id TEXT,
        agent_id TEXT NOT NULL,
        type TEXT NOT NULL,
        ts TEXT NOT NULL,
        seq_first INTEGER NOT NULL,
        seq_last INTEGER NOT NULL,
        sealed INTEGER NOT NULL DEFAULT 0,
        json TEXT NOT NULL
      );
    `);
    db.close();
    initSessionDb(dbPath);
    const columns = (
      getSessionDb().prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toContain('standing_fingerprint');
    expect(chatSchemaVersion()).toBe('5');
  });

  it('is idempotent across reopens', () => {
    buildV3ChatDb(dbPath);
    initSessionDb(dbPath);
    closeSessionDb();
    expect(() => initSessionDb(dbPath)).not.toThrow();
    expect(chatSchemaVersion()).toBe('5');
  });
});
