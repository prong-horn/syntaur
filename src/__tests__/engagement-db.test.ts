import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
  getSessionDb,
} from '../dashboard/session-db.js';
import {
  openEngagement,
  getOpenEngagement,
  closeEngagementById,
  closeOpenEngagement,
  ensureOpenEngagement,
  switchEngagement,
} from '../db/engagement-db.js';
import type { TokenSnapshot } from '../db/engagement-tokens.js';

function snap(total: number, capturedAt = '2026-03-26T10:00:00.000Z'): TokenSnapshot {
  return {
    models: {
      'claude-opus': { input: total, output: 0, cacheCreation: 0, cacheRead: 0, total, cost: 0 },
    },
    collectorRunAt: capturedAt,
    capturedAt,
  };
}

let testDir: string;
let dbPath: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-engagement-test-'));
  dbPath = resolve(testDir, 'test.db');
  resetSessionDb();
  initSessionDb(dbPath);
});

afterEach(async () => {
  closeSessionDb();
  await rm(testDir, { recursive: true, force: true });
});

describe('engagement schema', () => {
  it('creates the engagement table with the expected columns', () => {
    const db = getSessionDb();
    const cols = (
      db.prepare('PRAGMA table_info(engagement)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        'id',
        'session_id',
        'assignment_id',
        'project_slug',
        'assignment_slug',
        'stage',
        'started_at',
        'ended_at',
        'tokens_at_open',
        'tokens_at_close',
        'close_reason',
      ]),
    );
  });

  it('enforces at most one open engagement per session via a partial unique index', () => {
    const db = getSessionDb();
    const indexes = (
      db.prepare('PRAGMA index_list(engagement)').all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(indexes).toContain('one_active_per_session');
  });

  it('seeds its own engagement_schema_version meta row', () => {
    const db = getSessionDb();
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'engagement_schema_version'")
      .get() as { value: string } | undefined;
    expect(row?.value).toBe('1');
  });
});

describe('engagement open / get / close', () => {
  it('opens an active engagement and reads it back as the open one', () => {
    const row = openEngagement({
      sessionId: 's1',
      assignmentId: 'a-uuid',
      projectSlug: 'proj',
      assignmentSlug: 'asg',
      stage: 'plan',
      startedAt: '2026-03-26T10:00:00.000Z',
      tokensAtOpen: snap(100),
    });
    expect(row.ended_at).toBeNull();
    expect(row.stage).toBe('plan');

    const open = getOpenEngagement('s1');
    expect(open?.id).toBe(row.id);
    expect(open?.assignment_id).toBe('a-uuid');
    expect(open?.project_slug).toBe('proj');
  });

  it('rejects a second raw open for the same session (one-open invariant)', () => {
    openEngagement({ sessionId: 's1', startedAt: '2026-03-26T10:00:00.000Z' });
    expect(() =>
      openEngagement({ sessionId: 's1', startedAt: '2026-03-26T11:00:00.000Z' }),
    ).toThrow();
  });

  it('closeEngagementById is a compare-and-close: re-closing the same interval is a no-op', () => {
    const row = openEngagement({ sessionId: 's1', startedAt: '2026-03-26T10:00:00.000Z' });
    const first = closeEngagementById({
      id: row.id,
      startedAt: row.started_at,
      closeReason: 'completed',
      endedAt: '2026-03-26T12:00:00.000Z',
    });
    expect(first).toBe(true);
    const second = closeEngagementById({
      id: row.id,
      startedAt: row.started_at,
      closeReason: 'completed',
      endedAt: '2026-03-26T13:00:00.000Z',
    });
    expect(second).toBe(false);
    expect(getOpenEngagement('s1')).toBeNull();
  });

  it('closeOpenEngagement closes the session current open interval', () => {
    openEngagement({ sessionId: 's1', startedAt: '2026-03-26T10:00:00.000Z' });
    const closed = closeOpenEngagement('s1', {
      closeReason: 'abandoned',
      endedAt: '2026-03-26T12:00:00.000Z',
    });
    expect(closed).toBe(true);
    expect(getOpenEngagement('s1')).toBeNull();
    // a fresh open is allowed once the prior one is closed
    expect(() =>
      openEngagement({ sessionId: 's1', startedAt: '2026-03-26T13:00:00.000Z' }),
    ).not.toThrow();
  });
});

describe('ensureOpenEngagement (idempotent)', () => {
  it('opens when none exists, then no-ops when one already exists', () => {
    const a = ensureOpenEngagement({
      sessionId: 's1',
      assignmentId: 'a1',
      startedAt: '2026-03-26T10:00:00.000Z',
    });
    expect(a).not.toBeNull();
    const b = ensureOpenEngagement({
      sessionId: 's1',
      assignmentId: 'a2',
      startedAt: '2026-03-26T11:00:00.000Z',
    });
    // no switch — the original open engagement is preserved
    const open = getOpenEngagement('s1');
    expect(open?.assignment_id).toBe('a1');
    expect(b).toBeNull();
    const count = (
      getSessionDb()
        .prepare('SELECT COUNT(*) AS n FROM engagement WHERE session_id = ?')
        .get('s1') as { n: number }
    ).n;
    expect(count).toBe(1);
  });
});

describe('switchEngagement', () => {
  it('closes the current open and opens a new one in one transaction with a single snapshot', () => {
    openEngagement({
      sessionId: 's1',
      assignmentId: 'a1',
      stage: 'plan',
      startedAt: '2026-03-26T10:00:00.000Z',
      tokensAtOpen: snap(100),
    });
    const boundary = snap(500, '2026-03-26T12:00:00.000Z');
    const next = switchEngagement({
      sessionId: 's1',
      assignmentId: 'a1',
      stage: 'implement',
      startedAt: '2026-03-26T12:00:00.000Z',
      tokensSnapshot: boundary,
    });

    // exactly one open afterward = the new one
    const open = getOpenEngagement('s1');
    expect(open?.id).toBe(next.id);
    expect(open?.stage).toBe('implement');

    // the closed interval carries the boundary snapshot as tokens_at_close,
    // and the new interval carries the SAME snapshot as tokens_at_open
    const rows = getSessionDb()
      .prepare('SELECT * FROM engagement WHERE session_id = ? ORDER BY id')
      .all('s1') as Array<{
      ended_at: string | null;
      close_reason: string | null;
      tokens_at_open: string | null;
      tokens_at_close: string | null;
    }>;
    expect(rows).toHaveLength(2);
    const [closed, opened] = rows;
    expect(closed.ended_at).toBe('2026-03-26T12:00:00.000Z');
    expect(closed.close_reason).toBe('switch');
    expect(JSON.parse(closed.tokens_at_close!).models['claude-opus'].total).toBe(500);
    expect(JSON.parse(opened.tokens_at_open!).models['claude-opus'].total).toBe(500);
  });

  it('opens a first engagement when the session has none open', () => {
    const row = switchEngagement({
      sessionId: 's1',
      assignmentId: 'a1',
      stage: 'plan',
      startedAt: '2026-03-26T10:00:00.000Z',
      tokensSnapshot: snap(0),
    });
    expect(getOpenEngagement('s1')?.id).toBe(row.id);
  });
});
