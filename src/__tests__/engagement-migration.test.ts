import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
  getSessionDb,
} from '../dashboard/session-db.js';

let testDir: string;
let homeDir: string;
let dbPath: string;
let prevHome: string | undefined;

const STANDALONE_UUID = '99999999-9999-4999-8999-999999999999';
const PROJ_ASG_ID = '11111111-1111-4111-8111-111111111111';

/** Build a v5-shape sessions DB (slugs present, no engagement, no activity). */
function buildV5Db(path: string): void {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      project_slug TEXT,
      assignment_slug TEXT,
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_sessions_status ON sessions(status);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '5');
  const ins = db.prepare(
    `INSERT INTO sessions
       (session_id, project_slug, assignment_slug, agent, started, ended, status, path, updated_at)
     VALUES (@sid, @ps, @as, 'claude', @started, @ended, @status, @path, @updated)`,
  );
  ins.run({ sid: 's-proj', ps: 'proj-a', as: 'asg-1', started: '2026-03-26T10:00:00.000Z', ended: null, status: 'active', path: '/w/a', updated: '2026-03-26T10:00:00.000Z' });
  ins.run({ sid: 's-standalone', ps: null, as: STANDALONE_UUID, started: '2026-03-26T09:00:00.000Z', ended: '2026-03-26 14:00:00', status: 'completed', path: '/w/b', updated: '2026-03-26T14:00:00.000Z' });
  ins.run({ sid: 's-unresolved', ps: 'ghost', as: 'missing', started: '2026-03-26T08:00:00.000Z', ended: null, status: 'stopped', path: '/w/c', updated: '2026-03-26T12:00:00.000Z' });
  ins.run({ sid: 's-noslug', ps: null, as: null, started: '2026-03-26T07:00:00.000Z', ended: null, status: 'stopped', path: '/w/d', updated: '2026-03-26T11:00:00.000Z' });
  db.close();
}

async function writeAssignmentFile(dir: string, id: string, slug: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, 'assignment.md'),
    `---\nid: ${id}\nslug: ${slug}\ntitle: "T"\nstatus: in_progress\n---\n\n# ${slug}\n`,
    'utf-8',
  );
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-mig-test-'));
  homeDir = resolve(testDir, 'home');
  dbPath = resolve(testDir, 'syntaur.db');
  prevHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = homeDir;
  await writeAssignmentFile(resolve(homeDir, 'projects/proj-a/assignments/asg-1'), PROJ_ASG_ID, 'asg-1');
  await writeAssignmentFile(resolve(homeDir, 'assignments', STANDALONE_UUID), STANDALONE_UUID, STANDALONE_UUID);
  resetSessionDb();
});

afterEach(async () => {
  closeSessionDb();
  if (prevHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = prevHome;
  await rm(testDir, { recursive: true, force: true });
});

describe('v5 → v6 migration shape', () => {
  it('adds engagement + activity, drops slug columns, bumps versions', () => {
    buildV5Db(dbPath);
    initSessionDb(dbPath);
    const db = getSessionDb();

    const sessionCols = (
      db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(sessionCols).toContain('activity');
    expect(sessionCols).not.toContain('project_slug');
    expect(sessionCols).not.toContain('assignment_slug');

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    ).map((t) => t.name);
    expect(tables).toContain('engagement');

    expect(
      (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value,
    ).toBe('6');
    expect(
      (db.prepare("SELECT value FROM meta WHERE key='engagement_schema_version'").get() as { value: string }).value,
    ).toBe('1');
  });

  it('fresh install has the v6 shape directly (no slug columns, has engagement)', () => {
    initSessionDb(dbPath); // no prior file
    const db = getSessionDb();
    const cols = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('activity');
    expect(cols).not.toContain('project_slug');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).toContain('engagement');
  });
});

describe('backfill', () => {
  it('creates one engagement per session with the right attribution + open/closed mapping', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    buildV5Db(dbPath);
    initSessionDb(dbPath);
    const db = getSessionDb();

    const rows = db
      .prepare('SELECT * FROM engagement ORDER BY session_id')
      .all() as Array<{
      session_id: string;
      assignment_id: string | null;
      project_slug: string | null;
      assignment_slug: string | null;
      ended_at: string | null;
      close_reason: string | null;
    }>;
    expect(rows).toHaveLength(4);

    const bySession = Object.fromEntries(rows.map((r) => [r.session_id, r]));

    // project-nested, active → open, resolved id
    expect(bySession['s-proj'].assignment_id).toBe(PROJ_ASG_ID);
    expect(bySession['s-proj'].project_slug).toBe('proj-a');
    expect(bySession['s-proj'].ended_at).toBeNull();

    // standalone completed → closed 'completed', resolved by UUID, ended preserved
    expect(bySession['s-standalone'].assignment_id).toBe(STANDALONE_UUID);
    expect(bySession['s-standalone'].ended_at).toBe('2026-03-26 14:00:00');
    expect(bySession['s-standalone'].close_reason).toBe('completed');

    // slug present but unresolved → unattributed, stopped → closed 'abandoned',
    // ended falls back to updated_at (ended + transcript both absent)
    expect(bySession['s-unresolved'].assignment_id).toBeNull();
    expect(bySession['s-unresolved'].close_reason).toBe('abandoned');
    expect(bySession['s-unresolved'].ended_at).toBe('2026-03-26T12:00:00.000Z');

    // no slug → unattributed
    expect(bySession['s-noslug'].assignment_id).toBeNull();

    const attributed = rows.filter((r) => r.assignment_id !== null).length;
    expect(attributed).toBe(2);

    // counts logged
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/backfill/i);
    expect(logged).toMatch(/backfilled=4/);
    expect(logged).toMatch(/unattributed=2/);
    logSpy.mockRestore();
  });

  it('does not abort the migration when a scan directory is unreadable', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Replace the projects DIR with a FILE so readdirSync throws ENOTDIR mid-scan.
    await rm(resolve(homeDir, 'projects'), { recursive: true, force: true });
    await writeFile(resolve(homeDir, 'projects'), 'not a directory', 'utf-8');

    buildV5Db(dbPath);
    // The migration must still complete (backfill resolves what it can; the
    // unreadable tree degrades to unattributed instead of aborting).
    expect(() => initSessionDb(dbPath)).not.toThrow();
    const db = getSessionDb();
    expect(
      (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value,
    ).toBe('6');
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM engagement').get() as { n: number }).n,
    ).toBe(4);
    logSpy.mockRestore();
  });
});
