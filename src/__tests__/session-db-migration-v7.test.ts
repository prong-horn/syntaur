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

/** Build a v6-shape sessions DB (activity present, no hosted_by). */
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
  const ins = db.prepare(
    `INSERT INTO sessions (session_id, agent, started, ended, status, path, pid, activity)
     VALUES (@sid, @agent, @started, @ended, @status, @path, @pid, @activity)`,
  );
  ins.run({ sid: 'v6-row-1', agent: 'claude', started: '2026-07-01T10:00:00.000Z', ended: null, status: 'active', path: '/w/a', pid: 4242, activity: 'working' });
  ins.run({ sid: 'v6-row-2', agent: 'codex', started: '2026-07-01T09:00:00.000Z', ended: '2026-07-01T12:00:00.000Z', status: 'completed', path: '/w/b', pid: null, activity: null });
  db.close();
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-v7-mig-'));
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

describe('v6 → v7 migration (adds hosted_by)', () => {
  it('preserves rows, adds NULL hosted_by, migration chain reaches current version', () => {
    buildV6Db(dbPath);
    initSessionDb(dbPath);
    const db = getSessionDb();

    const cols = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('hosted_by');
    expect(cols).toContain('activity');

    const rows = db
      .prepare('SELECT session_id, agent, status, pid, activity, hosted_by FROM sessions ORDER BY session_id')
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ session_id: 'v6-row-1', agent: 'claude', status: 'active', pid: 4242, activity: 'working', hosted_by: null });
    expect(rows[1]).toMatchObject({ session_id: 'v6-row-2', agent: 'codex', status: 'completed', hosted_by: null });

    expect(
      (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value,
    ).toBe('9');
  });

  it('fresh install has hosted_by directly and head version', () => {
    initSessionDb(dbPath); // no prior file
    const db = getSessionDb();
    const cols = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('hosted_by');
    expect(
      (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value,
    ).toBe('9');
  });

  it('appendSession round-trips hostedBy; a later upsert WITHOUT it does not clobber (hook convergence)', async () => {
    initSessionDb(dbPath);
    const { appendSession, listAllSessions } = await import('../dashboard/agent-sessions.js');
    await appendSession('', {
      sessionId: 'sd-1', agent: 'codex', started: '2026-07-01T10:00:00.000Z',
      status: 'active', path: '/w/a', projectSlug: null, assignmentSlug: null, hostedBy: 'syntaurd',
    });
    await appendSession('', {
      sessionId: 'sd-1', agent: 'codex', started: '2026-07-01T10:00:00.000Z',
      status: 'active', path: '/w/a', projectSlug: null, assignmentSlug: null,
    });
    const all = await listAllSessions('');
    expect(all.find((s) => s.sessionId === 'sd-1')?.hostedBy).toBe('syntaurd');
  });
});
