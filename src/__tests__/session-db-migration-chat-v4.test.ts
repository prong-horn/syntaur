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
import { CHAT_DDL } from '../db/chat-schema.js';

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
    INSERT INTO meta (key, value) VALUES ('engagement_schema_version', '1');
  `);
  db.exec(CHAT_DDL.replace(
    `CREATE TABLE IF NOT EXISTS chat_harness_options (
  harness         TEXT PRIMARY KEY,
  adapter_version TEXT,
  captured_at     TEXT,
  record_json     TEXT,
  auth_state      TEXT NOT NULL DEFAULT 'unknown',
  auth_detail     TEXT,
  auth_at         TEXT
);
`,
    '',
  ));
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
    expect(chatSchemaVersion()).toBe('4');
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
      INSERT INTO meta (key, value) VALUES ('engagement_schema_version', '1');
    `);
    db.exec(CHAT_DDL.replace(',\n  standing_fingerprint TEXT', ''));
    db.close();
    initSessionDb(dbPath);
    const columns = (
      getSessionDb().prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toContain('standing_fingerprint');
    expect(chatSchemaVersion()).toBe('4');
  });

  it('is idempotent across reopens', () => {
    buildV3ChatDb(dbPath);
    initSessionDb(dbPath);
    closeSessionDb();
    expect(() => initSessionDb(dbPath)).not.toThrow();
    expect(chatSchemaVersion()).toBe('4');
  });
});
