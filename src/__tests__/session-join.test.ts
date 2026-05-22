import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { initSessionDb, closeSessionDb, resetSessionDb } from '../dashboard/session-db.js';
import { resolveAttribution } from '../usage/session-join.js';

let sandbox: string;
let dbPath: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-session-join-'));
  dbPath = resolve(sandbox, 'syntaur.db');
  resetSessionDb();
});

afterEach(async () => {
  closeSessionDb();
  await rm(sandbox, { recursive: true, force: true });
});

function seedSession(
  db: ReturnType<typeof initSessionDb>,
  row: {
    sessionId: string;
    projectSlug?: string | null;
    assignmentSlug?: string | null;
    started: string;
    ended?: string | null;
    path?: string | null;
  },
) {
  db.prepare(
    `INSERT INTO sessions
       (session_id, project_slug, assignment_slug, agent, started, ended, status, path)
     VALUES (@sessionId, @projectSlug, @assignmentSlug, 'claude-code', @started, @ended, 'active', @path)`,
  ).run({
    sessionId: row.sessionId,
    projectSlug: row.projectSlug ?? null,
    assignmentSlug: row.assignmentSlug ?? null,
    started: row.started,
    ended: row.ended ?? null,
    path: row.path ?? null,
  });
}

describe('resolveAttribution', () => {
  it('PK match wins', () => {
    const db = initSessionDb(dbPath);
    seedSession(db, {
      sessionId: 'sess-1',
      projectSlug: 'myproj',
      assignmentSlug: 'myasgn',
      started: '2026-05-21T12:00:00.000Z',
      path: '/Users/dev/proj',
    });
    const result = resolveAttribution({
      sessionId: 'sess-1',
      cwd: null,
      eventTs: '2026-05-21T13:00:00.000Z',
    });
    expect(result).toEqual({ projectSlug: 'myproj', assignmentSlug: 'myasgn' });
  });

  it('fuzzy match by path + time window when PK misses', () => {
    const db = initSessionDb(dbPath);
    seedSession(db, {
      sessionId: 'sess-tracked',
      projectSlug: 'myproj',
      assignmentSlug: 'myasgn',
      started: '2026-05-21T11:00:00.000Z',
      ended: '2026-05-21 14:00:00', // SQLite datetime('now') format
      path: '/Users/dev/proj',
    });
    const result = resolveAttribution({
      sessionId: 'sess-untracked',
      cwd: '/Users/dev/proj',
      eventTs: '2026-05-21T12:30:00.000Z',
    });
    expect(result).toEqual({ projectSlug: 'myproj', assignmentSlug: 'myasgn' });
  });

  it('fuzzy match handles open-ended (ended IS NULL) sessions', () => {
    const db = initSessionDb(dbPath);
    seedSession(db, {
      sessionId: 'still-running',
      projectSlug: 'p',
      assignmentSlug: 'a',
      started: '2026-05-21T11:00:00.000Z',
      ended: null,
      path: '/Users/dev/proj',
    });
    const result = resolveAttribution({
      sessionId: 'other',
      cwd: '/Users/dev/proj',
      eventTs: '2026-05-21T13:00:00.000Z',
    });
    expect(result).toEqual({ projectSlug: 'p', assignmentSlug: 'a' });
  });

  it('julianday() handles ISO/SQLite-datetime mixed format correctly', () => {
    const db = initSessionDb(dbPath);
    // Real-world: started is ISO, ended is SQLite datetime('now') format
    seedSession(db, {
      sessionId: 'mixed-format',
      projectSlug: 'p',
      assignmentSlug: 'a',
      started: '2026-05-21T11:00:00.000Z',
      ended: '2026-05-21 14:00:00',
      path: '/Users/dev/proj',
    });
    // Event within the window should match
    const inside = resolveAttribution({
      sessionId: 'other',
      cwd: '/Users/dev/proj',
      eventTs: '2026-05-21T12:00:00.000Z',
    });
    expect(inside.projectSlug).toBe('p');
    // Event after the window should NOT match
    const outside = resolveAttribution({
      sessionId: 'other',
      cwd: '/Users/dev/proj',
      eventTs: '2026-05-21T18:00:00.000Z',
    });
    expect(outside.projectSlug).toBeNull();
  });

  it('most-recently-started wins when multiple sessions share path', () => {
    const db = initSessionDb(dbPath);
    seedSession(db, {
      sessionId: 'older',
      projectSlug: 'old-project',
      assignmentSlug: 'old-asgn',
      started: '2026-05-21T10:00:00.000Z',
      ended: null,
      path: '/Users/dev/proj',
    });
    seedSession(db, {
      sessionId: 'newer',
      projectSlug: 'new-project',
      assignmentSlug: 'new-asgn',
      started: '2026-05-21T11:00:00.000Z',
      ended: null,
      path: '/Users/dev/proj',
    });
    const result = resolveAttribution({
      sessionId: 'unattributed',
      cwd: '/Users/dev/proj',
      eventTs: '2026-05-21T12:00:00.000Z',
    });
    expect(result.projectSlug).toBe('new-project');
  });

  it('returns nulls when neither PK nor fuzzy matches', () => {
    initSessionDb(dbPath);
    const result = resolveAttribution({
      sessionId: 'nobody',
      cwd: '/Users/dev/elsewhere',
      eventTs: '2026-05-21T12:00:00.000Z',
    });
    expect(result).toEqual({ projectSlug: null, assignmentSlug: null });
  });

  it('returns nulls when cwd is null and PK does not match', () => {
    initSessionDb(dbPath);
    const result = resolveAttribution({
      sessionId: 'nobody',
      cwd: null,
      eventTs: '2026-05-21T12:00:00.000Z',
    });
    expect(result).toEqual({ projectSlug: null, assignmentSlug: null });
  });
});
