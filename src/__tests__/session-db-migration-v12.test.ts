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

/**
 * v11 → v12: the lease, inventory and artifact subsystems go. Five tables are
 * dropped in FK order and the `proof_schema_version` / `lease_schema_version`
 * meta rows are deleted. The same drops run unconditionally on every init so a
 * stale CLI cannot leave the tables behind on an already-v12 database.
 */

const RETIRED_TABLES = [
  'lease_events',
  'leases',
  'inventory_members',
  'inventories',
  'artifacts',
] as const;

let testDir: string;
let dbPath: string;
let prevHome: string | undefined;

function schemaVersion(): string {
  return (
    getSessionDb()
      .prepare("SELECT value FROM meta WHERE key='schema_version'")
      .get() as { value: string }
  ).value;
}

function tableExists(name: string): boolean {
  return !!getSessionDb()
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

function metaValue(key: string): string | undefined {
  return (
    getSessionDb().prepare("SELECT value FROM meta WHERE key=?").get(key) as
      | { value: string }
      | undefined
  )?.value;
}

function rowCount(table: string): number {
  return (
    getSessionDb().prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }
  ).c;
}

/** Seed a v11 database with the five retired tables (one row each) and meta rows. */
function buildV11Db(path: string): void {
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

    CREATE TABLE inventories (
      slug TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      display_name TEXT,
      default_ttl_s INTEGER NOT NULL CHECK (default_ttl_s > 0),
      created_at TEXT NOT NULL
    );
    CREATE TABLE inventory_members (
      inventory_slug TEXT NOT NULL,
      member_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      generation INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT,
      last_used_at TEXT,
      retired_at TEXT,
      PRIMARY KEY (inventory_slug, member_id),
      FOREIGN KEY (inventory_slug) REFERENCES inventories(slug)
    );
    CREATE TABLE leases (
      lease_id TEXT PRIMARY KEY,
      inventory_slug TEXT NOT NULL,
      member_id TEXT NOT NULL,
      member_gen INTEGER NOT NULL,
      state TEXT NOT NULL,
      granted_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      released_at TEXT,
      requested_for TEXT,
      FOREIGN KEY (inventory_slug, member_id)
        REFERENCES inventory_members(inventory_slug, member_id)
    );
    CREATE TABLE lease_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lease_id TEXT NOT NULL,
      event TEXT NOT NULL,
      at TEXT NOT NULL,
      detail_json TEXT,
      FOREIGN KEY (lease_id) REFERENCES leases(lease_id)
    );
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL,
      assignment_dir TEXT NOT NULL,
      criterion_index INTEGER,
      kind TEXT NOT NULL,
      file_path TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '11');
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('lease_schema_version', '1');
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('proof_schema_version', '1');

  db.prepare(
    `INSERT INTO sessions (session_id, agent, started, status, path)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('sess-1', 'claude', '2026-08-01T10:00:00.000Z', 'active', '/w/test');

  db.prepare(
    `INSERT INTO engagement (session_id, project_slug, assignment_slug, stage, started_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('sess-1', 'proj', 'asgn', 'implement', '2026-08-01T10:00:00.000Z');

  db.prepare(
    `INSERT INTO inventories (slug, kind, default_ttl_s, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run('inv-1', 'pool', 3600, '2026-08-01T09:00:00.000Z');

  db.prepare(
    `INSERT INTO inventory_members (inventory_slug, member_id, status, generation)
     VALUES (?, ?, ?, ?)`,
  ).run('inv-1', 'member-1', 'idle', 0);

  db.prepare(
    `INSERT INTO leases (lease_id, inventory_slug, member_id, member_gen, state, granted_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'lease-1',
    'inv-1',
    'member-1',
    0,
    'active',
    '2026-08-01T10:00:00.000Z',
    '2026-08-01T11:00:00.000Z',
  );

  db.prepare(
    `INSERT INTO lease_events (lease_id, event, at) VALUES (?, ?, ?)`,
  ).run('lease-1', 'granted', '2026-08-01T10:00:00.000Z');

  db.prepare(
    `INSERT INTO artifacts (id, assignment_id, assignment_dir, kind)
     VALUES (?, ?, ?, ?)`,
  ).run('art-1', 'proj/asgn', '/tmp/asgn', 'screenshot');

  db.close();
}

function createRetiredTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventories (
      slug TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      display_name TEXT,
      default_ttl_s INTEGER NOT NULL CHECK (default_ttl_s > 0),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inventory_members (
      inventory_slug TEXT NOT NULL,
      member_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      generation INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT,
      last_used_at TEXT,
      retired_at TEXT,
      PRIMARY KEY (inventory_slug, member_id),
      FOREIGN KEY (inventory_slug) REFERENCES inventories(slug)
    );
    CREATE TABLE IF NOT EXISTS leases (
      lease_id TEXT PRIMARY KEY,
      inventory_slug TEXT NOT NULL,
      member_id TEXT NOT NULL,
      member_gen INTEGER NOT NULL,
      state TEXT NOT NULL,
      granted_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      released_at TEXT,
      requested_for TEXT,
      FOREIGN KEY (inventory_slug, member_id)
        REFERENCES inventory_members(inventory_slug, member_id)
    );
    CREATE TABLE IF NOT EXISTS lease_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lease_id TEXT NOT NULL,
      event TEXT NOT NULL,
      at TEXT NOT NULL,
      detail_json TEXT,
      FOREIGN KEY (lease_id) REFERENCES leases(lease_id)
    );
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
  `);
  db.prepare(
    `INSERT INTO inventories (slug, kind, default_ttl_s, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run('stale-inv', 'pool', 3600, '2026-08-01T09:00:00.000Z');
  db.prepare(
    `INSERT INTO inventory_members (inventory_slug, member_id, status, generation)
     VALUES (?, ?, ?, ?)`,
  ).run('stale-inv', 'stale-member', 'idle', 0);
  db.prepare(
    `INSERT INTO leases (lease_id, inventory_slug, member_id, member_gen, state, granted_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'stale-lease',
    'stale-inv',
    'stale-member',
    0,
    'active',
    '2026-08-01T10:00:00.000Z',
    '2026-08-01T11:00:00.000Z',
  );
  db.prepare(`INSERT INTO lease_events (lease_id, event, at) VALUES (?, ?, ?)`).run(
    'stale-lease',
    'granted',
    '2026-08-01T10:00:00.000Z',
  );
  db.prepare(
    `INSERT INTO artifacts (id, assignment_id, assignment_dir, kind)
     VALUES (?, ?, ?, ?)`,
  ).run('stale-art', 'proj/asgn', '/tmp/asgn', 'screenshot');
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    'lease_schema_version',
    '1',
  );
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    'proof_schema_version',
    '1',
  );
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-v12-mig-'));
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

describe('v11 → v12 migration (drops lease, inventory and artifact tables)', () => {
  it('migrates a v11 database: drops the five tables and meta rows, preserves other rows', () => {
    buildV11Db(dbPath);
    const before = new Database(dbPath, { readonly: true });
    const sessionsBefore = (
      before.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }
    ).c;
    const engagementBefore = (
      before.prepare('SELECT COUNT(*) as c FROM engagement').get() as { c: number }
    ).c;
    before.close();

    initSessionDb(dbPath);

    expect(schemaVersion()).toBe('12');
    for (const table of RETIRED_TABLES) {
      expect(tableExists(table)).toBe(false);
    }
    expect(metaValue('lease_schema_version')).toBeUndefined();
    expect(metaValue('proof_schema_version')).toBeUndefined();
    expect(rowCount('sessions')).toBe(sessionsBefore);
    expect(rowCount('engagement')).toBe(engagementBefore);
  });

  it('initialises a fresh database at v12 without the retired tables', () => {
    initSessionDb(dbPath);

    expect(schemaVersion()).toBe('12');
    for (const table of RETIRED_TABLES) {
      expect(tableExists(table)).toBe(false);
    }
    expect(metaValue('lease_schema_version')).toBeUndefined();
    expect(metaValue('proof_schema_version')).toBeUndefined();
  });

  it('drops recreated retired tables on re-init without a schema version change', () => {
    initSessionDb(dbPath);
    expect(schemaVersion()).toBe('12');

    closeSessionDb();
    const db = new Database(dbPath);
    createRetiredTables(db);
    for (const table of RETIRED_TABLES) {
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table),
      ).toBeTruthy();
    }
    db.close();

    initSessionDb(dbPath);

    expect(schemaVersion()).toBe('12');
    for (const table of RETIRED_TABLES) {
      expect(tableExists(table)).toBe(false);
    }
    expect(metaValue('lease_schema_version')).toBeUndefined();
    expect(metaValue('proof_schema_version')).toBeUndefined();
  });
});
