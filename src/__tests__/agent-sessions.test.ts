import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
  migrateFromMarkdown,
} from '../dashboard/session-db.js';
import {
  appendSession,
  listAllSessions,
  listProjectSessions,
  updateSessionStatus,
  reconcileActiveSessions,
} from '../dashboard/agent-sessions.js';
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
    expect(version.value).toBe('3');
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
