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
  listMissionSessions,
  updateSessionStatus,
  reconcileActiveSessions,
} from '../dashboard/agent-sessions.js';
import type { AgentSession, AgentSessionStatus } from '../dashboard/types.js';

let testDir: string;
let dbPath: string;

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    missionSlug: 'test-mission',
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
    expect(all[0].missionSlug).toBe('test-mission');
    expect(all[0].assignmentSlug).toBe('test-assignment');
    expect(all[0].agent).toBe('claude');
    expect(all[0].status).toBe('active');
  });

  it('inserts and retrieves a standalone session (null mission/assignment)', async () => {
    const session = makeSession({ missionSlug: null, assignmentSlug: null, description: 'standalone test' });
    await appendSession('', session);

    const all = await listAllSessions('');
    expect(all).toHaveLength(1);
    expect(all[0].missionSlug).toBeNull();
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

describe('listMissionSessions', () => {
  it('filters by mission slug', async () => {
    await appendSession('', makeSession({ missionSlug: 'mission-a', sessionId: 's1' }));
    await appendSession('', makeSession({ missionSlug: 'mission-b', sessionId: 's2' }));

    const sessions = await listMissionSessions('', 'mission-a');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('s1');
  });

  it('excludes standalone sessions when filtering by mission', async () => {
    await appendSession('', makeSession({ missionSlug: 'mission-a', sessionId: 's1' }));
    await appendSession('', makeSession({ missionSlug: null, assignmentSlug: null, sessionId: 's2' }));

    const sessions = await listMissionSessions('', 'mission-a');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('s1');
  });

  it('filters by mission and assignment slug', async () => {
    await appendSession('', makeSession({ assignmentSlug: 'task-a', sessionId: 's1' }));
    await appendSession('', makeSession({ assignmentSlug: 'task-b', sessionId: 's2' }));

    const sessions = await listMissionSessions('', 'test-mission', 'task-a');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('s1');
  });
});

describe('reconcileActiveSessions', () => {
  it('marks sessions as completed when assignment is completed', async () => {
    const missionsDir = resolve(testDir, 'missions');
    const missionDir = resolve(missionsDir, 'test-mission');
    const assignmentDir = resolve(missionDir, 'assignments', 'test-assignment');
    await mkdir(assignmentDir, { recursive: true });
    await writeFile(
      resolve(assignmentDir, 'assignment.md'),
      '---\nstatus: completed\n---\n# Test',
    );

    await appendSession('', makeSession());

    const updated = await reconcileActiveSessions(missionsDir);
    expect(updated).toBe(1);

    const all = await listAllSessions('');
    expect(all[0].status).toBe('completed');
  });

  it('marks sessions as stopped when assignment is failed', async () => {
    const missionsDir = resolve(testDir, 'missions');
    const missionDir = resolve(missionsDir, 'test-mission');
    const assignmentDir = resolve(missionDir, 'assignments', 'test-assignment');
    await mkdir(assignmentDir, { recursive: true });
    await writeFile(
      resolve(assignmentDir, 'assignment.md'),
      '---\nstatus: failed\n---\n# Test',
    );

    await appendSession('', makeSession());

    const updated = await reconcileActiveSessions(missionsDir);
    expect(updated).toBe(1);

    const all = await listAllSessions('');
    expect(all[0].status).toBe('stopped');
  });

  it('skips standalone sessions (null mission/assignment)', async () => {
    const missionsDir = resolve(testDir, 'missions');
    const missionDir = resolve(missionsDir, 'test-mission');
    const assignmentDir = resolve(missionDir, 'assignments', 'test-assignment');
    await mkdir(assignmentDir, { recursive: true });
    await writeFile(
      resolve(assignmentDir, 'assignment.md'),
      '---\nstatus: completed\n---\n# Test',
    );

    // One attached session (should be reconciled) and one standalone (should be skipped)
    await appendSession('', makeSession({ sessionId: 'attached-1' }));
    await appendSession('', makeSession({ sessionId: 'standalone-1', missionSlug: null, assignmentSlug: null }));

    const updated = await reconcileActiveSessions(missionsDir);
    expect(updated).toBe(1);

    const all = await listAllSessions('');
    const attached = all.find((s) => s.sessionId === 'attached-1');
    const standalone = all.find((s) => s.sessionId === 'standalone-1');
    expect(attached?.status).toBe('completed');
    expect(standalone?.status).toBe('active');
  });

  it('does not update sessions for in-progress assignments', async () => {
    const missionsDir = resolve(testDir, 'missions');
    const missionDir = resolve(missionsDir, 'test-mission');
    const assignmentDir = resolve(missionDir, 'assignments', 'test-assignment');
    await mkdir(assignmentDir, { recursive: true });
    await writeFile(
      resolve(assignmentDir, 'assignment.md'),
      '---\nstatus: in_progress\n---\n# Test',
    );

    await appendSession('', makeSession());

    const updated = await reconcileActiveSessions(missionsDir);
    expect(updated).toBe(0);

    const all = await listAllSessions('');
    expect(all[0].status).toBe('active');
  });
});

describe('migrateFromMarkdown', () => {
  it('imports sessions from _index-sessions.md files', async () => {
    const missionsDir = resolve(testDir, 'missions');
    const missionDir = resolve(missionsDir, 'my-mission');
    await mkdir(missionDir, { recursive: true });
    await writeFile(
      resolve(missionDir, '_index-sessions.md'),
      `---
mission: my-mission
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

    const count = await migrateFromMarkdown(missionsDir);
    expect(count).toBe(2);

    const all = await listAllSessions('');
    expect(all).toHaveLength(2);
    expect(all.find((s) => s.sessionId === 'sess-abc')?.assignmentSlug).toBe('task-1');
    expect(all.find((s) => s.sessionId === 'sess-def')?.agent).toBe('codex');
  });

  it('skips migration if sessions already exist', async () => {
    await appendSession('', makeSession());

    const missionsDir = resolve(testDir, 'missions');
    const missionDir = resolve(missionsDir, 'my-mission');
    await mkdir(missionDir, { recursive: true });
    await writeFile(
      resolve(missionDir, '_index-sessions.md'),
      `---
mission: my-mission
generated: "2026-03-26T00:00:00Z"
activeSessions: 1
---

# Active Sessions

| Assignment | Agent | Session ID | Started | Status | Path |
|------------|-------|------------|---------|--------|------|
| task-1 | claude | sess-xyz | 2026-03-26T10:00:00Z | active | /tmp/work |
`,
    );

    const count = await migrateFromMarkdown(missionsDir);
    expect(count).toBe(0);

    const all = await listAllSessions('');
    expect(all).toHaveLength(1); // only the original session
  });
});
