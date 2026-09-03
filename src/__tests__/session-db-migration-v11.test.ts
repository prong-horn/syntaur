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
 * v10 → v11 (phase 4, Decision 6): the terminal-launch stack's storage goes.
 *
 * `launch_reservations` is dropped outright, and `sessions` is rebuilt without
 * `pid`, `pid_started_at` and `activity` — each written by `appendSession` but
 * read only by `computeIsLive`, the transcript scanner, the Agent View join and
 * `reconcileLaunchPlaceholder`, all deleted. `transcript_path` is KEPT: the
 * summarizer chain, `listSessionsNeedingSummary`, the session commands, the
 * doctor workspace check, context leases and engagement backfill read it.
 *
 * The copy is positional, so the row assertions below seed a DISTINCT value in
 * every surviving column: a slipped pair mis-assigns data silently.
 */

let testDir: string;
let dbPath: string;
let prevHome: string | undefined;

const V11_SESSION_COLUMNS = [
  'session_id',
  'agent',
  'started',
  'ended',
  'status',
  'path',
  'description',
  'transcript_path',
  'original_head_sha',
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

/** A v10-shape database with rows in every `hosted_by` flavour plus a reservation. */
function buildV10Db(path: string): void {
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
      pid INTEGER,
      pid_started_at TEXT,
      original_head_sha TEXT,
      activity TEXT,
      hosted_by TEXT,
      summary TEXT,
      summarized_at TEXT,
      description_source TEXT,
      pinned_at TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_sessions_status ON sessions(status);
    CREATE INDEX idx_sessions_started ON sessions(started);
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
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '10');
  db.prepare('INSERT INTO launch_reservations (launch_id, hosted_by, created_at) VALUES (?, ?, ?)').run(
    'launch-1',
    'syntaurd',
    '2026-08-01T10:00:00.000Z',
  );

  const ins = db.prepare(
    `INSERT INTO sessions (session_id, agent, started, ended, status, path, description,
                           transcript_path, pid, pid_started_at, original_head_sha, activity,
                           hosted_by, summary, summarized_at, description_source,
                           pinned_at, archived_at, created_at, updated_at)
     VALUES (@sid, @agent, @started, @ended, @status, @path, @description,
             @transcriptPath, @pid, @pidStartedAt, @originalHeadSha, @activity,
             @hostedBy, @summary, @summarizedAt, @descSource,
             @pinnedAt, @archivedAt, @createdAt, @updatedAt)`,
  );
  ins.run({
    sid: 'terminal-row', agent: 'claude', started: '2026-08-01T10:00:00.000Z',
    ended: '2026-08-01T11:00:00.000Z', status: 'stopped', path: '/w/terminal',
    description: 'a terminal session', transcriptPath: '/t/terminal.jsonl', pid: 4242,
    pidStartedAt: '2026-08-01T09:59:00.000Z', originalHeadSha: 'sha-terminal',
    activity: 'working', hostedBy: 'syntaurd', summary: 'summary-terminal',
    summarizedAt: '2026-08-01T11:05:00.000Z', descSource: 'auto',
    pinnedAt: '2026-08-01T11:06:00.000Z', archivedAt: null,
    createdAt: '2026-08-01T09:58:00.000Z', updatedAt: '2026-08-01T11:07:00.000Z',
  });
  ins.run({
    sid: 'chat-row', agent: 'claude', started: '2026-08-02T10:00:00.000Z',
    ended: null, status: 'active', path: '/w/chat',
    description: null, transcriptPath: '/t/chat.jsonl', pid: null,
    pidStartedAt: null, originalHeadSha: null, activity: null,
    hostedBy: 'acp', summary: null, summarizedAt: null, descSource: null,
    pinnedAt: null, archivedAt: null,
    createdAt: '2026-08-02T09:58:00.000Z', updatedAt: '2026-08-02T10:01:00.000Z',
  });
  ins.run({
    sid: 'tmux-row', agent: 'codex', started: '2026-08-03T10:00:00.000Z',
    ended: null, status: 'active', path: '/w/tmux',
    description: null, transcriptPath: null, pid: 99, pidStartedAt: null,
    originalHeadSha: null, activity: null, hostedBy: 'tmux', summary: null,
    summarizedAt: null, descSource: null, pinnedAt: null, archivedAt: null,
    createdAt: '2026-08-03T09:58:00.000Z', updatedAt: '2026-08-03T10:01:00.000Z',
  });
  db.close();
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-v11-mig-'));
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

describe('v10 → v11 migration (drops the launch columns and launch_reservations)', () => {
  it('rebuilds sessions without pid, pid_started_at or activity, keeping transcript_path', () => {
    buildV10Db(dbPath);
    initSessionDb(dbPath);

    // Exact order, not membership — the copy is positional.
    expect(columns()).toEqual(V11_SESSION_COLUMNS);
    expect(columns()).not.toContain('pid');
    expect(columns()).not.toContain('pid_started_at');
    expect(columns()).not.toContain('activity');
    expect(columns()).toContain('transcript_path');
    expect(schemaVersion()).toBe('11');
  });

  it('preserves every surviving column of every row', () => {
    buildV10Db(dbPath);
    initSessionDb(dbPath);

    const rows = getSessionDb()
      .prepare('SELECT * FROM sessions ORDER BY session_id')
      .all() as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.session_id)).toEqual(['chat-row', 'terminal-row', 'tmux-row']);

    expect(rows[1]).toEqual({
      session_id: 'terminal-row',
      agent: 'claude',
      started: '2026-08-01T10:00:00.000Z',
      ended: '2026-08-01T11:00:00.000Z',
      status: 'stopped',
      path: '/w/terminal',
      description: 'a terminal session',
      transcript_path: '/t/terminal.jsonl',
      original_head_sha: 'sha-terminal',
      hosted_by: null,
      summary: 'summary-terminal',
      summarized_at: '2026-08-01T11:05:00.000Z',
      description_source: 'auto',
      pinned_at: '2026-08-01T11:06:00.000Z',
      archived_at: null,
      created_at: '2026-08-01T09:58:00.000Z',
      updated_at: '2026-08-01T11:07:00.000Z',
    });
  });

  it("keeps hosted_by only for 'acp' rows, nulling every historical backend", () => {
    buildV10Db(dbPath);
    initSessionDb(dbPath);

    const hosted = Object.fromEntries(
      (
        getSessionDb().prepare('SELECT session_id, hosted_by FROM sessions').all() as Array<{
          session_id: string;
          hosted_by: string | null;
        }>
      ).map((r) => [r.session_id, r.hosted_by]),
    );
    // The TypeScript union is `'acp' | null`; the data now matches it.
    expect(hosted).toEqual({ 'chat-row': 'acp', 'terminal-row': null, 'tmux-row': null });
  });

  it('drops launch_reservations entirely', () => {
    buildV10Db(dbPath);
    initSessionDb(dbPath);

    const table = getSessionDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='launch_reservations'")
      .get() as { name: string } | undefined;
    expect(table).toBeUndefined();
  });

  it('keeps both paging indexes and is idempotent across reopens', () => {
    buildV10Db(dbPath);
    initSessionDb(dbPath);
    closeSessionDb();

    expect(() => initSessionDb(dbPath)).not.toThrow();
    const indexes = (
      getSessionDb()
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions'")
        .all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(indexes).toContain('idx_sessions_status');
    expect(indexes).toContain('idx_sessions_started');
    expect(schemaVersion()).toBe('11');
    expect(columns()).toEqual(V11_SESSION_COLUMNS);
  });
});
