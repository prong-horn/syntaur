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

/** Build a v7-shape sessions DB (hosted_by present, no summary columns). */
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
    `INSERT INTO sessions (session_id, agent, started, ended, status, path, description, hosted_by)
     VALUES (@sid, @agent, @started, @ended, @status, @path, @description, @hostedBy)`,
  );
  ins.run({
    sid: 'human-desc',
    agent: 'claude',
    started: '2026-07-01T10:00:00.000Z',
    ended: null,
    status: 'stopped',
    path: '/w/a',
    description: 'hand written label',
    hostedBy: 'tmux',
  });
  ins.run({
    sid: 'no-desc',
    agent: 'codex',
    started: '2026-07-01T09:00:00.000Z',
    ended: '2026-07-01T12:00:00.000Z',
    status: 'completed',
    path: '/w/b',
    description: null,
    hostedBy: null,
  });
  ins.run({
    sid: 'empty-desc',
    agent: 'claude',
    started: '2026-07-01T08:00:00.000Z',
    ended: null,
    status: 'stopped',
    path: '/w/c',
    description: '',
    hostedBy: null,
  });
  ins.run({
    sid: 'root-path',
    agent: 'claude',
    started: '2026-07-01T07:00:00.000Z',
    ended: null,
    status: 'stopped',
    path: '/',
    description: null,
    hostedBy: null,
  });
  db.close();
}

/** Build a v6-shape DB, to exercise the full v6 → v8 chain in one open. */
function buildV6Db(path: string): void {
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_sessions_status ON sessions(status);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '6');
  db.prepare(
    `INSERT INTO sessions (session_id, agent, started, status, path, description)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('v6-row', 'claude', '2026-07-01T10:00:00.000Z', 'stopped', '/w/a', 'from v6');
  db.close();
}

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

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-v8-mig-'));
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

describe('v7 → v8 migration (summary columns + provenance backfill)', () => {
  it('adds the summary columns and bumps the version', () => {
    buildV7Db(dbPath);
    initSessionDb(dbPath);

    const cols = columns();
    expect(cols).toContain('summary');
    expect(cols).toContain('summarized_at');
    expect(cols).toContain('description_source');
    // Pre-existing columns survive the table rebuild.
    expect(cols).toContain('hosted_by');
    expect(cols).toContain('activity');
    expect(schemaVersion()).toBe('10');
  });

  it('preserves existing row data through the rebuild', () => {
    buildV7Db(dbPath);
    initSessionDb(dbPath);

    const row = getSessionDb()
      .prepare('SELECT * FROM sessions WHERE session_id = ?')
      .get('human-desc') as Record<string, unknown>;
    expect(row).toMatchObject({
      agent: 'claude',
      started: '2026-07-01T10:00:00.000Z',
      status: 'stopped',
      path: '/w/a',
      description: 'hand written label',
      hosted_by: 'tmux',
    });
    expect(row.summary).toBeNull();
    expect(row.summarized_at).toBeNull();
  });

  it("backfills description_source='human' for existing non-empty descriptions only", () => {
    buildV7Db(dbPath);
    initSessionDb(dbPath);
    const db = getSessionDb();

    const get = (sid: string) =>
      (
        db
          .prepare('SELECT description_source FROM sessions WHERE session_id = ?')
          .get(sid) as { description_source: string | null }
      ).description_source;

    // Every description that predates the summarizer was written by a human or
    // a caller, so the summarizer must never overwrite one.
    expect(get('human-desc')).toBe('human');
    expect(get('no-desc')).toBeNull();
    expect(get('empty-desc')).toBeNull();
  });

  it("clears the degenerate path='/' rows", () => {
    buildV7Db(dbPath);
    initSessionDb(dbPath);
    const db = getSessionDb();

    const path = (
      db.prepare('SELECT path FROM sessions WHERE session_id = ?').get('root-path') as {
        path: string | null;
      }
    ).path;
    expect(path).toBeNull();

    const remaining = (
      db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE path = '/'").get() as { n: number }
    ).n;
    expect(remaining).toBe(0);

    // Real paths are untouched.
    expect(
      (
        db.prepare('SELECT path FROM sessions WHERE session_id = ?').get('human-desc') as {
          path: string | null;
        }
      ).path,
    ).toBe('/w/a');
  });

  it('creates the summarize_state table', () => {
    buildV7Db(dbPath);
    initSessionDb(dbPath);
    const cols = (
      getSessionDb().prepare('PRAGMA table_info(summarize_state)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        'session_id',
        'claim_token',
        'claimed_at',
        'next_attempt_at',
        'attempts',
        'last_error',
      ]),
    );
  });

  it('is idempotent across reopens', () => {
    buildV7Db(dbPath);
    initSessionDb(dbPath);
    closeSessionDb();
    resetSessionDb();
    initSessionDb(dbPath);

    expect(schemaVersion()).toBe('10');
    expect(columns()).toContain('summary');
    const rows = (
      getSessionDb().prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
    ).n;
    expect(rows).toBe(4);
  });
});

describe('migration chains and fresh install', () => {
  it('carries a v6 database all the way to head in one open', () => {
    buildV6Db(dbPath);
    initSessionDb(dbPath);

    const cols = columns();
    expect(cols).toContain('hosted_by'); // v7 step
    expect(cols).toContain('summary'); // v8 step
    expect(schemaVersion()).toBe('10');

    const row = getSessionDb()
      .prepare('SELECT description, description_source FROM sessions WHERE session_id = ?')
      .get('v6-row') as { description: string; description_source: string | null };
    expect(row.description).toBe('from v6');
    expect(row.description_source).toBe('human');
  });

  it('gives a fresh install the v8 shape directly', () => {
    initSessionDb(dbPath); // no prior file

    const cols = columns();
    expect(cols).toContain('summary');
    expect(cols).toContain('summarized_at');
    expect(cols).toContain('description_source');
    expect(schemaVersion()).toBe('10');
    // The aux table is created at init, not only by the migration step.
    expect(
      getSessionDb()
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='summarize_state'")
        .get(),
    ).toBeTruthy();
  });
});
