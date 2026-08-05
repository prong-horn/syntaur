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

/**
 * The exact v10 `sessions` column order. Asserted with toEqual (not
 * toContain) because the v9→v10 copy step is POSITIONAL — a swapped pair
 * mis-assigns data silently instead of erroring.
 */
const V10_SESSION_COLUMNS = [
  'session_id',
  'agent',
  'started',
  'ended',
  'status',
  'path',
  'description',
  'transcript_path',
  'pid',
  'pid_started_at',
  'original_head_sha',
  'activity',
  'hosted_by',
  'summary',
  'summarized_at',
  'description_source',
  'pinned_at',
  'archived_at',
  'created_at',
  'updated_at',
];

function schemaVersion(): string {
  return (
    getSessionDb()
      .prepare("SELECT value FROM meta WHERE key='schema_version'")
      .get() as { value: string }
  ).value;
}

function columns(): string[] {
  return (
    getSessionDb().prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
  ).map((c) => c.name);
}

function indexNames(): string[] {
  return (
    getSessionDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions'")
      .all() as Array<{ name: string }>
  ).map((i) => i.name);
}

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

/** Build a v9-shape sessions DB: 18-column sessions + launch_reservations, no curation flags. */
function buildV9Db(path: string): void {
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
    -- Deliberately NO idx_sessions_started: it shipped with server-side paging,
    -- after v9. A real v9 database upgrading to v10 will not have it, which is
    -- exactly the case the post-migration re-ensure has to cover.
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE launch_reservations (
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
  `);
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '9');
  const ins = db.prepare(
    `INSERT INTO sessions (session_id, agent, started, ended, status, path, description,
                           transcript_path, pid, pid_started_at, original_head_sha, activity,
                           hosted_by, summary, summarized_at, description_source, created_at, updated_at)
     VALUES (@sid, @agent, @started, @ended, @status, @path, @description,
             @transcriptPath, @pid, @pidStartedAt, @originalHeadSha, @activity,
             @hostedBy, @summary, @summarizedAt, @descSource, @createdAt, @updatedAt)`,
  );
  // Every payload column carries a DISTINCT value — a positional swap in the
  // v9→v10 copy changes one of these, and the assertions below catch it.
  ins.run({
    sid: 'v9-row-1', agent: 'claude', started: '2026-07-01T10:00:00.000Z',
    ended: '2026-07-01T11:00:00.000Z', status: 'stopped', path: '/w/a',
    description: 'desc-one', transcriptPath: '/t/one.jsonl', pid: 4242,
    pidStartedAt: '2026-07-01T09:59:00.000Z', originalHeadSha: 'sha-one',
    activity: 'working', hostedBy: 'syntaurd', summary: 'summary-one',
    summarizedAt: '2026-07-01T11:05:00.000Z', descSource: 'auto',
    createdAt: '2026-07-01T09:58:00.000Z', updatedAt: '2026-07-01T11:06:00.000Z',
  });
  ins.run({
    sid: 'v9-row-2', agent: 'codex', started: '2026-07-01T09:00:00.000Z',
    ended: null, status: 'active', path: '/w/b',
    description: null, transcriptPath: null, pid: null,
    pidStartedAt: null, originalHeadSha: null,
    activity: null, hostedBy: null, summary: null,
    summarizedAt: null, descSource: 'human',
    createdAt: '2026-07-01T08:58:00.000Z', updatedAt: '2026-07-01T09:01:00.000Z',
  });
  db.close();
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-v10-mig-'));
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

describe('v9 → v10 migration (adds pinned_at + archived_at)', () => {
  it('preserves every row and column value, adds the flags as NULL, keeps idx_sessions_status, bumps to 10', () => {
    buildV9Db(dbPath);
    initSessionDb(dbPath);

    // THE assertion that catches a positional slip: exact order, not membership.
    expect(columns()).toEqual(V10_SESSION_COLUMNS);

    const rows = getSessionDb()
      .prepare('SELECT * FROM sessions ORDER BY session_id')
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      session_id: 'v9-row-1',
      agent: 'claude',
      started: '2026-07-01T10:00:00.000Z',
      ended: '2026-07-01T11:00:00.000Z',
      status: 'stopped',
      path: '/w/a',
      description: 'desc-one',
      transcript_path: '/t/one.jsonl',
      pid: 4242,
      pid_started_at: '2026-07-01T09:59:00.000Z',
      original_head_sha: 'sha-one',
      activity: 'working',
      hosted_by: 'syntaurd',
      summary: 'summary-one',
      summarized_at: '2026-07-01T11:05:00.000Z',
      description_source: 'auto',
      created_at: '2026-07-01T09:58:00.000Z',
      updated_at: '2026-07-01T11:06:00.000Z',
      pinned_at: null,
      archived_at: null,
    });
    expect(rows[1]).toMatchObject({
      session_id: 'v9-row-2',
      agent: 'codex',
      status: 'active',
      description_source: 'human',
      pinned_at: null,
      archived_at: null,
    });

    // H2: ALTER TABLE ... RENAME drops every index on the table.
    // `idx_sessions_status` is re-created inline by the rebuild itself...
    expect(indexNames()).toContain('idx_sessions_status');
    // ...and `idx_sessions_started` (added alongside server-side paging) is NOT.
    // It is re-ensured by the tail of initSessionDb, which runs after every
    // migration. v10 is the last rebuild, so this asserts that mechanism
    // actually covers it — without it, paging silently full-scans.
    expect(indexNames()).toContain('idx_sessions_started');

    expect(schemaVersion()).toBe('10');
  });

  it('fresh install has the v10 shape directly and version 10', () => {
    initSessionDb(dbPath); // no prior file
    // Proves SCHEMA_SQL and the v9→v10 rebuild DDL stayed column-for-column in sync.
    expect(columns()).toEqual(V10_SESSION_COLUMNS);
    expect(indexNames()).toContain('idx_sessions_status');
    expect(indexNames()).toContain('idx_sessions_started');
    expect(schemaVersion()).toBe('10');
  });

  it('re-init after upgrade is idempotent (no throw, still version 10)', () => {
    buildV9Db(dbPath);
    initSessionDb(dbPath);
    closeSessionDb();

    expect(() => initSessionDb(dbPath)).not.toThrow();
    expect(schemaVersion()).toBe('10');
    expect(columns()).toEqual(V10_SESSION_COLUMNS);
  });

  it('v8 → v10 chain: both gated steps run in one open (launch_reservations AND the curation flags)', () => {
    buildV8Db(dbPath);
    initSessionDb(dbPath);

    expect(columns()).toEqual(V10_SESSION_COLUMNS);

    const tableRow = getSessionDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='launch_reservations'")
      .get() as { name: string } | undefined;
    expect(tableRow?.name).toBe('launch_reservations');

    // The v8 payload survives two rebuilds.
    const row = getSessionDb()
      .prepare('SELECT * FROM sessions WHERE session_id = ?')
      .get('v8-row-1') as Record<string, unknown>;
    expect(row).toMatchObject({
      agent: 'claude',
      status: 'active',
      pid: 4242,
      activity: 'working',
      hosted_by: 'syntaurd',
      summary: 'did a thing',
      description_source: 'auto',
      pinned_at: null,
      archived_at: null,
    });

    expect(schemaVersion()).toBe('10');
  });
});
