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

let testDir: string;
let dbPath: string;
let prevHome: string | undefined;

/** Build a v8-shape sessions DB (auto-summary columns present, no launch_reservations). */
function buildV8Db(path: string): void {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
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
    CREATE INDEX idx_sessions_status ON sessions(status);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '8');
  const ins = db.prepare(
    `INSERT INTO sessions (session_id, agent, started, ended, status, path, pid, activity, hosted_by, summary, description_source)
     VALUES (@sid, @agent, @started, @ended, @status, @path, @pid, @activity, @hostedBy, @summary, @descSource)`,
  );
  ins.run({ sid: 'v8-row-1', agent: 'claude', started: '2026-07-01T10:00:00.000Z', ended: null, status: 'active', path: '/w/a', pid: 4242, activity: 'working', hostedBy: 'syntaurd', summary: 'did a thing', descSource: 'auto' });
  ins.run({ sid: 'v8-row-2', agent: 'codex', started: '2026-07-01T09:00:00.000Z', ended: '2026-07-01T12:00:00.000Z', status: 'completed', path: '/w/b', pid: null, activity: null, hostedBy: null, summary: null, descSource: 'human' });
  db.close();
}

/** Build a v7-shape sessions DB (hosted_by present, no summary cols, no launch_reservations). */
function buildV7Db(path: string): void {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
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
      pid INTEGER,
      pid_started_at TEXT,
      original_head_sha TEXT,
      activity TEXT,
      hosted_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_sessions_status ON sessions(status);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '7');
  const ins = db.prepare(
    `INSERT INTO sessions (session_id, agent, started, ended, status, path, pid, activity, hosted_by)
     VALUES (@sid, @agent, @started, @ended, @status, @path, @pid, @activity, @hostedBy)`,
  );
  ins.run({ sid: 'v7-row-1', agent: 'claude', started: '2026-07-01T10:00:00.000Z', ended: null, status: 'active', path: '/w/a', pid: 4242, activity: 'working', hostedBy: 'syntaurd' });
  db.close();
}

const LAUNCH_RESERVATION_COLUMNS = [
  'launch_id',
  'hosted_by',
  'agent',
  'cwd',
  'expected_session_id',
  'created_at',
  'dispatched_at',
  'claimed_by',
  'claimed_at',
  'canceled_at',
];

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-v9-mig-'));
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

describe('v8 → v9 migration (adds launch_reservations)', () => {
  it('preserves rows (incl. summary cols), adds launch_reservations with the 10 D5 columns in order, bumps version to 9', () => {
    buildV8Db(dbPath);
    initSessionDb(dbPath);
    const db = getSessionDb();

    const tableRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='launch_reservations'")
      .get() as { name: string } | undefined;
    expect(tableRow?.name).toBe('launch_reservations');

    const cols = (db.prepare('PRAGMA table_info(launch_reservations)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toEqual(LAUNCH_RESERVATION_COLUMNS);

    const rows = db
      .prepare('SELECT session_id, agent, status, pid, activity, hosted_by, summary, description_source FROM sessions ORDER BY session_id')
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ session_id: 'v8-row-1', agent: 'claude', status: 'active', pid: 4242, activity: 'working', hosted_by: 'syntaurd', summary: 'did a thing', description_source: 'auto' });
    expect(rows[1]).toMatchObject({ session_id: 'v8-row-2', agent: 'codex', status: 'completed', hosted_by: null, description_source: 'human' });

    expect(
      (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value,
    ).toBe('9');
  });

  it('fresh install has launch_reservations directly and version 9', () => {
    initSessionDb(dbPath); // no prior file
    const db = getSessionDb();

    const tableRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='launch_reservations'")
      .get() as { name: string } | undefined;
    expect(tableRow?.name).toBe('launch_reservations');

    const cols = (db.prepare('PRAGMA table_info(launch_reservations)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toEqual(LAUNCH_RESERVATION_COLUMNS);

    expect(
      (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value,
    ).toBe('9');
  });

  it('re-init after upgrade is idempotent (no throw, still version 9)', () => {
    buildV8Db(dbPath);
    initSessionDb(dbPath);
    closeSessionDb();

    expect(() => initSessionDb(dbPath)).not.toThrow();
    const db = getSessionDb();
    expect(
      (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value,
    ).toBe('9');
  });

  it('v7 → v9 chain: both gated steps run in one transaction (summary cols AND launch_reservations present)', () => {
    buildV7Db(dbPath);
    initSessionDb(dbPath);
    const db = getSessionDb();

    const sessionCols = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(sessionCols).toContain('hosted_by');
    expect(sessionCols).toContain('summary');
    expect(sessionCols).toContain('description_source');

    const tableRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='launch_reservations'")
      .get() as { name: string } | undefined;
    expect(tableRow?.name).toBe('launch_reservations');

    expect(
      (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value,
    ).toBe('9');
  });
});
