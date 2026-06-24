import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
  getSessionDb,
  migrateFromMarkdown,
} from '../dashboard/session-db.js';
import {
  appendSession,
  listAllSessions,
  listProjectSessions,
  updateSessionStatus,
  SessionResurrectionError,
  reconcileActiveSessions,
  deleteSessions,
} from '../dashboard/agent-sessions.js';
import { getOpenEngagement } from '../db/engagement-db.js';
import { setCumulativeTokenSource, type TokenSnapshot } from '../db/engagement-tokens.js';
import type { AgentSession, AgentSessionStatus } from '../dashboard/types.js';

let testDir: string;
let dbPath: string;

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    projectSlug: 'test-project',
    assignmentSlug: 'test-assignment',
    agent: 'claude',
    sessionId: `session-${Math.random().toString(36).slice(2, 10)}`,
    started: '2026-03-26T10:00:00Z',
    status: 'active' as AgentSessionStatus,
    path: '/tmp/test',
    ...overrides,
  };
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-sessions-test-'));
  dbPath = resolve(testDir, 'test.db');
  resetSessionDb();
  initSessionDb(dbPath);
});

afterEach(async () => {
  setCumulativeTokenSource(null);
  closeSessionDb();
  await rm(testDir, { recursive: true, force: true });
});

describe('appendSession + listAllSessions', () => {
  it('inserts and retrieves a session', async () => {
    const session = makeSession();
    await appendSession('', session);

    const all = await listAllSessions('');
    expect(all).toHaveLength(1);
    expect(all[0].sessionId).toBe(session.sessionId);
    expect(all[0].projectSlug).toBe('test-project');
    expect(all[0].assignmentSlug).toBe('test-assignment');
    expect(all[0].agent).toBe('claude');
    expect(all[0].status).toBe('active');
  });

  it('inserts and retrieves a standalone session (null project/assignment)', async () => {
    const session = makeSession({ projectSlug: null, assignmentSlug: null, description: 'standalone test' });
    await appendSession('', session);

    const all = await listAllSessions('');
    expect(all).toHaveLength(1);
    expect(all[0].projectSlug).toBeNull();
    expect(all[0].assignmentSlug).toBeNull();
    expect(all[0].description).toBe('standalone test');
  });

  it('stores and returns the description field', async () => {
    const session = makeSession({ description: 'exploring auth patterns' });
    await appendSession('', session);

    const all = await listAllSessions('');
    expect(all).toHaveLength(1);
    expect(all[0].description).toBe('exploring auth patterns');
  });

  it('returns null description when not provided', async () => {
    const session = makeSession();
    await appendSession('', session);

    const all = await listAllSessions('');
    expect(all[0].description).toBeNull();
  });

  it('stores and returns transcriptPath on round-trip', async () => {
    const session = makeSession({ transcriptPath: '/tmp/agent-transcript.jsonl' });
    await appendSession('', session);

    const all = await listAllSessions('');
    expect(all).toHaveLength(1);
    expect(all[0].transcriptPath).toBe('/tmp/agent-transcript.jsonl');
  });

  it('returns null transcriptPath when not provided', async () => {
    const session = makeSession();
    await appendSession('', session);

    const all = await listAllSessions('');
    expect(all[0].transcriptPath).toBeNull();
  });

  it('returns sessions ordered by started DESC', async () => {
    await appendSession('', makeSession({ sessionId: 's1', started: '2026-03-26T09:00:00Z' }));
    await appendSession('', makeSession({ sessionId: 's2', started: '2026-03-26T11:00:00Z' }));
    await appendSession('', makeSession({ sessionId: 's3', started: '2026-03-26T10:00:00Z' }));

    const all = await listAllSessions('');
    expect(all.map((s) => s.sessionId)).toEqual(['s2', 's3', 's1']);
  });
});

describe('updateSessionStatus', () => {
  it('updates status and returns true', async () => {
    const session = makeSession();
    await appendSession('', session);

    const updated = await updateSessionStatus('', session.sessionId, 'completed');
    expect(updated).toBe(true);

    const all = await listAllSessions('');
    expect(all[0].status).toBe('completed');
    expect(all[0].ended).toBeTruthy();
  });

  it('includes ended field in mapped session', async () => {
    const session = makeSession();
    await appendSession('', session);

    const before = await listAllSessions('');
    expect(before[0].ended).toBeNull();

    await updateSessionStatus('', session.sessionId, 'stopped');

    const after = await listAllSessions('');
    expect(after[0].ended).toBeTruthy();
    expect(typeof after[0].ended).toBe('string');
  });

  it('sets ended timestamp for terminal statuses', async () => {
    const session = makeSession();
    await appendSession('', session);

    await updateSessionStatus('', session.sessionId, 'stopped');

    const { getSessionDb } = await import('../dashboard/session-db.js');
    const db = getSessionDb();
    const row = db.prepare('SELECT ended FROM sessions WHERE session_id = ?').get(session.sessionId) as { ended: string | null };
    expect(row.ended).toBeTruthy();
  });

  it('returns false for non-existent session', async () => {
    const updated = await updateSessionStatus('', 'nonexistent', 'completed');
    expect(updated).toBe(false);
  });
});

describe('listProjectSessions', () => {
  it('filters by project slug', async () => {
    await appendSession('', makeSession({ projectSlug: 'project-a', sessionId: 's1' }));
    await appendSession('', makeSession({ projectSlug: 'project-b', sessionId: 's2' }));

    const sessions = await listProjectSessions('', 'project-a');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('s1');
  });

  it('excludes standalone sessions when filtering by project', async () => {
    await appendSession('', makeSession({ projectSlug: 'project-a', sessionId: 's1' }));
    await appendSession('', makeSession({ projectSlug: null, assignmentSlug: null, sessionId: 's2' }));

    const sessions = await listProjectSessions('', 'project-a');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('s1');
  });

  it('filters by project and assignment slug', async () => {
    await appendSession('', makeSession({ assignmentSlug: 'task-a', sessionId: 's1' }));
    await appendSession('', makeSession({ assignmentSlug: 'task-b', sessionId: 's2' }));

    const sessions = await listProjectSessions('', 'test-project', 'task-a');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('s1');
  });
});

describe('reconcileActiveSessions', () => {
  it('marks sessions as completed when assignment is completed', async () => {
    const projectsDir = resolve(testDir, 'projects');
    const projectDir = resolve(projectsDir, 'test-project');
    const assignmentDir = resolve(projectDir, 'assignments', 'test-assignment');
    await mkdir(assignmentDir, { recursive: true });
    await writeFile(
      resolve(assignmentDir, 'assignment.md'),
      '---\nstatus: completed\n---\n# Test',
    );

    await appendSession('', makeSession());

    const updated = await reconcileActiveSessions(projectsDir);
    expect(updated).toBe(1);

    const all = await listAllSessions('');
    expect(all[0].status).toBe('completed');
  });

  it('marks sessions as stopped when assignment is failed', async () => {
    const projectsDir = resolve(testDir, 'projects');
    const projectDir = resolve(projectsDir, 'test-project');
    const assignmentDir = resolve(projectDir, 'assignments', 'test-assignment');
    await mkdir(assignmentDir, { recursive: true });
    await writeFile(
      resolve(assignmentDir, 'assignment.md'),
      '---\nstatus: failed\n---\n# Test',
    );

    await appendSession('', makeSession());

    const updated = await reconcileActiveSessions(projectsDir);
    expect(updated).toBe(1);

    const all = await listAllSessions('');
    expect(all[0].status).toBe('stopped');
  });

  it('skips standalone sessions (null project/assignment)', async () => {
    const projectsDir = resolve(testDir, 'projects');
    const projectDir = resolve(projectsDir, 'test-project');
    const assignmentDir = resolve(projectDir, 'assignments', 'test-assignment');
    await mkdir(assignmentDir, { recursive: true });
    await writeFile(
      resolve(assignmentDir, 'assignment.md'),
      '---\nstatus: completed\n---\n# Test',
    );

    // One attached session (should be reconciled) and one standalone (should be skipped)
    await appendSession('', makeSession({ sessionId: 'attached-1' }));
    await appendSession('', makeSession({ sessionId: 'standalone-1', projectSlug: null, assignmentSlug: null }));

    const updated = await reconcileActiveSessions(projectsDir);
    expect(updated).toBe(1);

    const all = await listAllSessions('');
    const attached = all.find((s) => s.sessionId === 'attached-1');
    const standalone = all.find((s) => s.sessionId === 'standalone-1');
    expect(attached?.status).toBe('completed');
    expect(standalone?.status).toBe('active');
  });

  it('does not update sessions for in-progress assignments', async () => {
    const projectsDir = resolve(testDir, 'projects');
    const projectDir = resolve(projectsDir, 'test-project');
    const assignmentDir = resolve(projectDir, 'assignments', 'test-assignment');
    await mkdir(assignmentDir, { recursive: true });
    await writeFile(
      resolve(assignmentDir, 'assignment.md'),
      '---\nstatus: in_progress\n---\n# Test',
    );

    await appendSession('', makeSession());

    const updated = await reconcileActiveSessions(projectsDir);
    expect(updated).toBe(0);

    const all = await listAllSessions('');
    expect(all[0].status).toBe('active');
  });
});

describe('migrateFromMarkdown', () => {
  it('imports sessions from _index-sessions.md files', async () => {
    const projectsDir = resolve(testDir, 'projects');
    const projectDir = resolve(projectsDir, 'my-project');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      resolve(projectDir, '_index-sessions.md'),
      `---
project: my-project
generated: "2026-03-26T00:00:00Z"
activeSessions: 1
---

# Active Sessions

| Assignment | Agent | Session ID | Started | Status | Path |
|------------|-------|------------|---------|--------|------|
| task-1 | claude | sess-abc | 2026-03-26T10:00:00Z | active | /tmp/work |
| task-2 | codex | sess-def | 2026-03-26T09:00:00Z | completed | /tmp/other |
`,
    );

    const count = await migrateFromMarkdown(projectsDir);
    expect(count).toBe(2);

    const all = await listAllSessions('');
    expect(all).toHaveLength(2);
    expect(all.find((s) => s.sessionId === 'sess-abc')?.assignmentSlug).toBe('task-1');
    expect(all.find((s) => s.sessionId === 'sess-def')?.agent).toBe('codex');

    // The active import gets an OPEN engagement; the completed import must be
    // imported as a CLOSED engagement (no leaked open interval).
    expect(getOpenEngagement('sess-abc')).not.toBeNull();
    expect(getOpenEngagement('sess-def')).toBeNull();
  });

  it('does not leak an open engagement when a duplicate session_id is ignored', async () => {
    // Same session id appears twice (e.g. across index files): terminal first,
    // active second. INSERT OR IGNORE keeps the first (terminal) session row, so
    // the active duplicate must NOT create an open engagement.
    const projectsDir = resolve(testDir, 'projects');
    const projectDir = resolve(projectsDir, 'dup-project');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      resolve(projectDir, '_index-sessions.md'),
      `---
project: dup-project
generated: "2026-03-26T00:00:00Z"
activeSessions: 2
---

# Active Sessions

| Assignment | Agent | Session ID | Started | Status | Path |
|------------|-------|------------|---------|--------|------|
| task-1 | claude | dup-sess | 2026-03-26T10:00:00Z | completed | /tmp/work |
| task-1 | claude | dup-sess | 2026-03-26T11:00:00Z | active | /tmp/work |
`,
    );

    await migrateFromMarkdown(projectsDir);

    const all = await listAllSessions('');
    expect(all).toHaveLength(1);
    expect(all.find((s) => s.sessionId === 'dup-sess')?.status).toBe('completed');
    expect(getOpenEngagement('dup-sess')).toBeNull();
  });

  it('skips migration if sessions already exist', async () => {
    await appendSession('', makeSession());

    const projectsDir = resolve(testDir, 'projects');
    const projectDir = resolve(projectsDir, 'my-project');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      resolve(projectDir, '_index-sessions.md'),
      `---
project: my-project
generated: "2026-03-26T00:00:00Z"
activeSessions: 1
---

# Active Sessions

| Assignment | Agent | Session ID | Started | Status | Path |
|------------|-------|------------|---------|--------|------|
| task-1 | claude | sess-xyz | 2026-03-26T10:00:00Z | active | /tmp/work |
`,
    );

    const count = await migrateFromMarkdown(projectsDir);
    expect(count).toBe(0);

    const all = await listAllSessions('');
    expect(all).toHaveLength(1); // only the original session
  });
});

describe('v2 -> v3 schema migration (adds transcript_path)', () => {
  it('preserves existing rows and exposes transcriptPath as null; table has transcript_path column', async () => {
    // beforeEach already created a v3 db at dbPath. Tear it down and reseed
    // from scratch as if this were an older v2 installation.
    closeSessionDb();
    resetSessionDb();
    await rm(dbPath, { force: true });
    const { default: Database } = await import('better-sqlite3');
    const seedDb = new Database(dbPath);
    seedDb.pragma('journal_mode = WAL');
    seedDb.exec(`
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
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_sessions_project ON sessions(project_slug);
      CREATE INDEX idx_sessions_assignment ON sessions(project_slug, assignment_slug);
      CREATE INDEX idx_sessions_status ON sessions(status);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta (key, value) VALUES ('schema_version', '2');
      INSERT INTO sessions (session_id, project_slug, assignment_slug, agent, started, status, path, description)
      VALUES
        ('legacy-1', 'p1', 'a1', 'claude', '2026-03-26T10:00:00Z', 'active', '/tmp/p1', 'first legacy'),
        ('legacy-2', 'p2', 'a2', 'codex',  '2026-03-26T11:00:00Z', 'completed', '/tmp/p2', NULL);
    `);
    seedDb.close();

    // Re-open via the migration path.
    initSessionDb(dbPath);

    const all = await listAllSessions('');
    expect(all).toHaveLength(2);
    const legacy1 = all.find((s) => s.sessionId === 'legacy-1');
    const legacy2 = all.find((s) => s.sessionId === 'legacy-2');
    expect(legacy1?.projectSlug).toBe('p1');
    expect(legacy1?.description).toBe('first legacy');
    expect(legacy1?.transcriptPath).toBeNull();
    expect(legacy2?.agent).toBe('codex');
    expect(legacy2?.transcriptPath).toBeNull();

    const { getSessionDb } = await import('../dashboard/session-db.js');
    const db = getSessionDb();
    const columns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    expect(names).toContain('transcript_path');

    const version = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string };
    // v2 chains through every migration to the current head (v6).
    expect(version.value).toBe('6');
  });

  it('falls back to mission_slug when a v2 table has both columns but project_slug is null', async () => {
    closeSessionDb();
    resetSessionDb();
    await rm(dbPath, { force: true });
    const { default: Database } = await import('better-sqlite3');
    const seedDb = new Database(dbPath);
    seedDb.pragma('journal_mode = WAL');
    seedDb.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        project_slug TEXT,
        mission_slug TEXT,
        assignment_slug TEXT,
        agent TEXT NOT NULL,
        started TEXT NOT NULL,
        ended TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        path TEXT,
        description TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta (key, value) VALUES ('schema_version', '2');
      INSERT INTO sessions (session_id, project_slug, mission_slug, assignment_slug, agent, started, status, path)
      VALUES
        ('new-row',   'new-proj', NULL,         'a1', 'claude', '2026-03-26T10:00:00Z', 'active', '/tmp/p1'),
        ('old-row',   NULL,       'legacy-proj', 'a2', 'claude', '2026-03-26T11:00:00Z', 'active', '/tmp/p2');
    `);
    seedDb.close();

    initSessionDb(dbPath);

    const all = await listAllSessions('');
    const newRow = all.find((s) => s.sessionId === 'new-row');
    const oldRow = all.find((s) => s.sessionId === 'old-row');
    expect(newRow?.projectSlug).toBe('new-proj');
    expect(oldRow?.projectSlug).toBe('legacy-proj'); // COALESCE fallback pulled from mission_slug
  });

  it('maps legacy v2 mission_slug column into project_slug during v2→v3', async () => {
    // Older installations have a v2 table whose project column is named
    // `mission_slug` (from pre-v0.2.0 when the product was called "missions").
    // The v0.2.0 code rename didn't ship a DB migration, so this test pins
    // the v2→v3 upgrade as the place where the rename lands.
    closeSessionDb();
    resetSessionDb();
    await rm(dbPath, { force: true });
    const { default: Database } = await import('better-sqlite3');
    const seedDb = new Database(dbPath);
    seedDb.pragma('journal_mode = WAL');
    seedDb.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        mission_slug TEXT,
        assignment_slug TEXT,
        agent TEXT NOT NULL,
        started TEXT NOT NULL,
        ended TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        path TEXT,
        description TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_sessions_mission ON sessions(mission_slug);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta (key, value) VALUES ('schema_version', '2');
      INSERT INTO sessions (session_id, mission_slug, assignment_slug, agent, started, status, path)
      VALUES ('legacy-mission', 'legacy-proj', 'legacy-assn', 'claude', '2026-03-26T10:00:00Z', 'active', '/tmp/legacy');
    `);
    seedDb.close();

    initSessionDb(dbPath);

    const all = await listAllSessions('');
    expect(all).toHaveLength(1);
    expect(all[0].sessionId).toBe('legacy-mission');
    // The mission_slug value survives the rename AND the v6 move onto the
    // engagement edge — surfaced here via the chosen-engagement projection.
    expect(all[0].projectSlug).toBe('legacy-proj');
    expect(all[0].transcriptPath).toBeNull();

    const { getSessionDb } = await import('../dashboard/session-db.js');
    const db = getSessionDb();
    const cols = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    // v6: the scalar binding has moved off `sessions` onto `engagement`.
    expect(cols).not.toContain('project_slug');
    expect(cols).not.toContain('mission_slug');
    expect(cols).not.toContain('assignment_slug');
    expect(cols).toContain('activity');
    expect(cols).toContain('transcript_path');
  });
});

describe('v3 -> v4 schema migration (adds pid + pid_started_at)', () => {
  it('preserves existing rows and exposes pid/pidStartedAt as null; columns added; version bumped to 4', async () => {
    // beforeEach already created a v4 db. Tear it down and reseed as v3.
    closeSessionDb();
    resetSessionDb();
    await rm(dbPath, { force: true });
    const { default: Database } = await import('better-sqlite3');
    const seedDb = new Database(dbPath);
    seedDb.pragma('journal_mode = WAL');
    seedDb.exec(`
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
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_sessions_project ON sessions(project_slug);
      CREATE INDEX idx_sessions_assignment ON sessions(project_slug, assignment_slug);
      CREATE INDEX idx_sessions_status ON sessions(status);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta (key, value) VALUES ('schema_version', '3');
      INSERT INTO sessions (session_id, project_slug, assignment_slug, agent, started, status, path, description, transcript_path)
      VALUES
        ('v3-row-1', 'p1', 'a1', 'claude', '2026-05-19T10:00:00Z', 'active',    '/tmp/p1', 'first',  '/tmp/t1.jsonl'),
        ('v3-row-2', 'p2', 'a2', 'codex',  '2026-05-19T11:00:00Z', 'completed', '/tmp/p2', NULL,     NULL);
    `);
    seedDb.close();

    initSessionDb(dbPath);

    const all = await listAllSessions('');
    expect(all).toHaveLength(2);
    const row1 = all.find((s) => s.sessionId === 'v3-row-1');
    const row2 = all.find((s) => s.sessionId === 'v3-row-2');
    expect(row1?.projectSlug).toBe('p1');
    expect(row1?.transcriptPath).toBe('/tmp/t1.jsonl');
    expect(row1?.pid ?? null).toBeNull();
    expect(row1?.pidStartedAt ?? null).toBeNull();
    expect(row2?.agent).toBe('codex');
    expect(row2?.pid ?? null).toBeNull();

    const { getSessionDb } = await import('../dashboard/session-db.js');
    const db = getSessionDb();
    const columns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    expect(names).toContain('pid');
    expect(names).toContain('pid_started_at');

    const version = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string };
    // v3→v4 adds pid columns, then the chain continues to the current head (v6).
    expect(version.value).toBe('6');
  });
});

describe('v4 -> v5 schema migration (adds original_head_sha)', () => {
  it('preserves existing rows, adds original_head_sha (null), bumps version to 5', async () => {
    // beforeEach already created a v5 db. Tear it down and reseed as v4.
    closeSessionDb();
    resetSessionDb();
    await rm(dbPath, { force: true });
    const { default: Database } = await import('better-sqlite3');
    const seedDb = new Database(dbPath);
    seedDb.pragma('journal_mode = WAL');
    seedDb.exec(`
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
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_sessions_project ON sessions(project_slug);
      CREATE INDEX idx_sessions_assignment ON sessions(project_slug, assignment_slug);
      CREATE INDEX idx_sessions_status ON sessions(status);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta (key, value) VALUES ('schema_version', '4');
      INSERT INTO sessions (session_id, project_slug, assignment_slug, agent, started, status, path, transcript_path, pid)
      VALUES
        ('v4-row-1', 'p1', 'a1', 'claude', '2026-05-30T10:00:00Z', 'active',    '/tmp/p1', '/tmp/t1.jsonl', 4242),
        ('v4-row-2', 'p2', 'a2', 'codex',  '2026-05-30T11:00:00Z', 'completed', '/tmp/p2', NULL,            NULL);
    `);
    seedDb.close();

    initSessionDb(dbPath);

    const all = await listAllSessions('');
    expect(all).toHaveLength(2);
    const row1 = all.find((s) => s.sessionId === 'v4-row-1');
    const row2 = all.find((s) => s.sessionId === 'v4-row-2');
    expect(row1?.projectSlug).toBe('p1');
    expect(row1?.pid).toBe(4242);
    expect(row1?.originalHeadSha ?? null).toBeNull();
    expect(row2?.agent).toBe('codex');
    expect(row2?.originalHeadSha ?? null).toBeNull();

    const { getSessionDb } = await import('../dashboard/session-db.js');
    const db = getSessionDb();
    const columns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toContain('original_head_sha');

    const version = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(version.value).toBe('6');
  });

  it('round-trips original_head_sha through appendSession + getSessionById', async () => {
    const { getSessionById } = await import('../dashboard/agent-sessions.js');
    await appendSession(
      '',
      makeSession({ sessionId: 'sha-row', originalHeadSha: 'deadbeefcafef00d' }),
    );
    expect(getSessionById('sha-row')?.originalHeadSha).toBe('deadbeefcafef00d');
  });

  it('preserves the ORIGINAL sha across re-registration (does not let a later HEAD clobber it)', async () => {
    const { getSessionById } = await import('../dashboard/agent-sessions.js');
    await appendSession('', makeSession({ sessionId: 'sha-keep', originalHeadSha: 'sha1' }));
    // A later re-track after HEAD moved must NOT overwrite the original anchor.
    await appendSession('', makeSession({ sessionId: 'sha-keep', originalHeadSha: 'sha2' }));
    expect(getSessionById('sha-keep')?.originalHeadSha).toBe('sha1');
  });

  it('backfills original_head_sha when the first registration captured none', async () => {
    const { getSessionById } = await import('../dashboard/agent-sessions.js');
    await appendSession('', makeSession({ sessionId: 'sha-fill', originalHeadSha: null }));
    await appendSession('', makeSession({ sessionId: 'sha-fill', originalHeadSha: 'sha2' }));
    expect(getSessionById('sha-fill')?.originalHeadSha).toBe('sha2');
  });
});

describe('appendSession upsert semantics', () => {
  it('second call with same session_id enriches existing row without resetting started', async () => {
    const base = makeSession({
      sessionId: 'real-session-123',
      projectSlug: null,
      assignmentSlug: null,
      description: null,
      transcriptPath: null,
      started: '2026-03-26T10:00:00Z',
    });
    await appendSession('', base);

    const enrich = makeSession({
      sessionId: 'real-session-123',
      projectSlug: 'p1',
      assignmentSlug: 'a1',
      description: 'attached later',
      transcriptPath: '/tmp/t.jsonl',
      started: '2099-12-31T23:59:59Z', // should be ignored by upsert
    });
    await appendSession('', enrich);

    const all = await listAllSessions('');
    expect(all).toHaveLength(1);
    const row = all[0];
    expect(row.sessionId).toBe('real-session-123');
    expect(row.projectSlug).toBe('p1');
    expect(row.assignmentSlug).toBe('a1');
    expect(row.description).toBe('attached later');
    expect(row.transcriptPath).toBe('/tmp/t.jsonl');
    expect(row.started).toBe('2026-03-26T10:00:00Z'); // preserved from first insert
  });

  it('does not revive a terminal session via re-registration', async () => {
    const sid = 'terminal-session-xyz';
    await appendSession('', makeSession({ sessionId: sid }));
    await updateSessionStatus('', sid, 'completed');

    await appendSession(
      '',
      makeSession({ sessionId: sid, status: 'active' as AgentSessionStatus, description: 'late-arriving' }),
    );

    const all = await listAllSessions('');
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('completed');
    expect(all[0].description).toBe('late-arriving'); // fields still merged
  });
});

describe('narrow revival rule (reviveStopped)', () => {
  it('revives a stopped row to active when reviveStopped is set', async () => {
    const sid = 'revivable-session';
    await appendSession('', makeSession({ sessionId: sid }));
    await updateSessionStatus('', sid, 'stopped');

    await appendSession(
      '',
      makeSession({ sessionId: sid, status: 'active' as AgentSessionStatus }),
      { reviveStopped: true },
    );

    const all = await listAllSessions('');
    expect(all[0].status).toBe('active');
  });

  it('does not revive a stopped row without reviveStopped', async () => {
    const sid = 'stays-stopped';
    await appendSession('', makeSession({ sessionId: sid }));
    await updateSessionStatus('', sid, 'stopped');

    await appendSession(
      '',
      makeSession({ sessionId: sid, status: 'active' as AgentSessionStatus }),
    );

    const all = await listAllSessions('');
    expect(all[0].status).toBe('stopped');
  });

  it('never revives a completed row, even with reviveStopped', async () => {
    const sid = 'completed-stays';
    await appendSession('', makeSession({ sessionId: sid }));
    await updateSessionStatus('', sid, 'completed');

    await appendSession(
      '',
      makeSession({ sessionId: sid, status: 'active' as AgentSessionStatus }),
      { reviveStopped: true },
    );

    const all = await listAllSessions('');
    expect(all[0].status).toBe('completed');
  });

  it('reviveStopped with a non-active payload leaves a stopped row stopped', async () => {
    const sid = 'stopped-on-stopped';
    await appendSession('', makeSession({ sessionId: sid }));
    await updateSessionStatus('', sid, 'stopped');

    await appendSession(
      '',
      makeSession({ sessionId: sid, status: 'stopped' as AgentSessionStatus }),
      { reviveStopped: true },
    );

    const all = await listAllSessions('');
    expect(all[0].status).toBe('stopped');
  });
});

describe('updateSessionStatus explicit endedAt', () => {
  it('writes the provided endedAt for a terminal status', async () => {
    const session = makeSession();
    await appendSession('', session);

    await updateSessionStatus('', session.sessionId, 'stopped', '2026-01-02T03:04:05.000Z');

    const all = await listAllSessions('');
    expect(all[0].ended).toBe('2026-01-02T03:04:05.000Z');
  });

  it('defaults ended to now when endedAt is omitted', async () => {
    const session = makeSession();
    await appendSession('', session);

    await updateSessionStatus('', session.sessionId, 'stopped');

    const all = await listAllSessions('');
    expect(all[0].ended).toBeTruthy();
    expect(all[0].ended).not.toBe('2026-01-02T03:04:05.000Z');
  });
});

describe('appendSession engagement binding (persisted-status guard)', () => {
  it('opens an engagement for a fresh active session with a binding', async () => {
    await appendSession('', makeSession({ sessionId: 's-active' }));
    expect(getOpenEngagement('s-active')).not.toBeNull();
  });

  it('does NOT open an engagement when re-registering a persisted completed session as active', async () => {
    await appendSession('', makeSession({ sessionId: 's-done', status: 'completed' }));
    expect(getOpenEngagement('s-done')).toBeNull(); // terminal → never opened

    // Re-registration arrives as active, but the persisted status stays completed;
    // an engagement must NOT be opened for a terminal session.
    await appendSession('', makeSession({ sessionId: 's-done', status: 'active' }));
    const all = await listAllSessions('');
    expect(all.find((s) => s.sessionId === 's-done')?.status).toBe('completed');
    expect(getOpenEngagement('s-done')).toBeNull();
  });

  it('does NOT open an engagement when re-registering a stopped session as active without reviveStopped', async () => {
    await appendSession('', makeSession({ sessionId: 's-stop', status: 'stopped' }));
    await appendSession('', makeSession({ sessionId: 's-stop', status: 'active' }));
    expect(getOpenEngagement('s-stop')).toBeNull();
  });

  it('opens an engagement when a stopped session is revived to active', async () => {
    await appendSession('', makeSession({ sessionId: 's-revive', status: 'stopped' }));
    await appendSession(
      '',
      makeSession({ sessionId: 's-revive', status: 'active' }),
      { reviveStopped: true },
    );
    expect(getOpenEngagement('s-revive')).not.toBeNull();
  });

  it('clears the stale ended timestamp when a stopped session is revived to active', async () => {
    await appendSession('', makeSession({ sessionId: 's-rv' }));
    await updateSessionStatus('', 's-rv', 'stopped', '2026-03-26T12:00:00.000Z');
    expect((await listAllSessions('')).find((s) => s.sessionId === 's-rv')?.ended).toBe(
      '2026-03-26T12:00:00.000Z',
    );

    await appendSession('', makeSession({ sessionId: 's-rv', status: 'active' }), {
      reviveStopped: true,
    });
    const revived = (await listAllSessions('')).find((s) => s.sessionId === 's-rv');
    expect(revived?.status).toBe('active');
    expect(revived?.ended).toBeNull(); // an active session must not carry a terminal ended
  });

  it('records a CLOSED engagement for a first-seen terminal session that has a binding', async () => {
    // e.g. the scanner discovers a stale stopped transcript with a binding.
    await appendSession('', makeSession({ sessionId: 's-hist', status: 'stopped' }));
    expect(getOpenEngagement('s-hist')).toBeNull(); // not open
    const row = getSessionDb()
      .prepare(
        'SELECT project_slug, ended_at, close_reason FROM engagement WHERE session_id = ?',
      )
      .get('s-hist') as { project_slug: string; ended_at: string | null; close_reason: string } | undefined;
    expect(row?.project_slug).toBe('test-project'); // binding preserved as a closed interval
    expect(row?.ended_at).not.toBeNull();
    expect(row?.close_reason).toBe('abandoned');
  });

  it('reopens an engagement from history when a stopped session is revived with no fresh binding', async () => {
    await appendSession('', makeSession({ sessionId: 's-rb' }));
    await updateSessionStatus('', 's-rb', 'stopped', '2026-03-26T12:00:00.000Z');
    expect(getOpenEngagement('s-rb')).toBeNull();

    // revive payload carries NO binding (e.g. resume-mode launch)
    await appendSession(
      '',
      makeSession({ sessionId: 's-rb', status: 'active', projectSlug: null, assignmentSlug: null }),
      { reviveStopped: true },
    );
    const open = getOpenEngagement('s-rb');
    expect(open?.project_slug).toBe('test-project'); // recovered from the prior engagement
  });

  it('updateSessionStatus to active reopens an engagement from history (stopped revive, clears ended)', async () => {
    await appendSession('', makeSession({ sessionId: 's-ua' }));
    await updateSessionStatus('', 's-ua', 'stopped', '2026-03-26T12:00:00.000Z');
    expect(getOpenEngagement('s-ua')).toBeNull();

    await updateSessionStatus('', 's-ua', 'active');
    expect(getOpenEngagement('s-ua')?.project_slug).toBe('test-project');
    // The stale `ended` from the stop is cleared in the same revive transaction.
    const row = getSessionDb()
      .prepare('SELECT status, ended FROM sessions WHERE session_id = ?')
      .get('s-ua') as { status: string; ended: string | null };
    expect(row.status).toBe('active');
    expect(row.ended).toBeNull();
  });

  it('refuses to resurrect a COMPLETED session to active (and leaves no open engagement)', async () => {
    await appendSession('', makeSession({ sessionId: 's-done' }));
    await updateSessionStatus('', 's-done', 'completed', '2026-03-26T12:00:00.000Z');
    expect(getOpenEngagement('s-done')).toBeNull();

    await expect(updateSessionStatus('', 's-done', 'active')).rejects.toBeInstanceOf(
      SessionResurrectionError,
    );
    // Row stays completed; the closed cost window is NOT reopened.
    const row = getSessionDb()
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('s-done') as { status: string };
    expect(row.status).toBe('completed');
    expect(getOpenEngagement('s-done')).toBeNull();
  });

  it('deleteSessions removes the session AND its engagement rows (no orphans)', async () => {
    await appendSession('', makeSession({ sessionId: 's-del' }));
    expect(getOpenEngagement('s-del')).not.toBeNull();

    const n = await deleteSessions(['s-del']);
    expect(n).toBe(1);
    const remaining = (
      getSessionDb()
        .prepare('SELECT COUNT(*) AS n FROM engagement WHERE session_id = ?')
        .get('s-del') as { n: number }
    ).n;
    expect(remaining).toBe(0);
  });

  it('terminal transition closes the open engagement and captures a tokens_at_close snapshot', async () => {
    const snap: TokenSnapshot = {
      models: { m: { input: 1, output: 1, cacheCreation: 0, cacheRead: 0, total: 2, cost: 0 } },
      collectorRunAt: '2026-03-26T09:00:00.000Z',
      capturedAt: '2026-03-26T10:00:00.000Z',
    };
    setCumulativeTokenSource(async () => snap);

    await appendSession('', makeSession({ sessionId: 's-term' }));
    expect(getOpenEngagement('s-term')).not.toBeNull();

    await updateSessionStatus('', 's-term', 'completed', '2026-03-26T12:00:00.000Z');

    expect(getOpenEngagement('s-term')).toBeNull();
    const row = getSessionDb()
      .prepare(
        'SELECT ended_at, close_reason, tokens_at_close FROM engagement WHERE session_id = ?',
      )
      .get('s-term') as { ended_at: string; close_reason: string; tokens_at_close: string | null };
    expect(row.ended_at).toBe('2026-03-26T12:00:00.000Z');
    expect(row.close_reason).toBe('completed');
    expect(JSON.parse(row.tokens_at_close!).models.m.total).toBe(2);
  });
});
