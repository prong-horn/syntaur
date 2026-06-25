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
  switchEngagement,
  type EngagementRow,
} from '../db/engagement-db.js';
import {
  appendSession,
  getSessionById,
  livenessStopSession,
} from '../dashboard/agent-sessions.js';
import type { TokenSnapshot } from '../db/engagement-tokens.js';
import type { AgentSession } from '../dashboard/types.js';

function snap(total: number, capturedAt = '2026-06-24T10:00:00.000Z'): TokenSnapshot {
  return {
    models: {
      'claude-opus': { input: total, output: 0, cacheCreation: 0, cacheRead: 0, total, cost: 0 },
    },
    collectorRunAt: capturedAt,
    capturedAt,
  };
}

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    projectSlug: null,
    assignmentSlug: null,
    agent: 'claude',
    sessionId: 'sess-1',
    started: '2026-06-24T08:00:00.000Z',
    status: 'active',
    path: '/tmp/test',
    ...overrides,
  };
}

/** Seed an active session row + a single open engagement; return that engagement. */
async function seedActiveWithEngagement(
  sessionId: string,
  startedAt = '2026-06-24T08:00:00.000Z',
): Promise<EngagementRow> {
  await appendSession('', makeSession({ sessionId, started: startedAt }));
  return openEngagement({
    sessionId,
    projectSlug: 'proj',
    assignmentSlug: 'assn',
    stage: 'implement',
    startedAt,
  });
}

function engagementById(id: number): EngagementRow {
  return getSessionDb()
    .prepare('SELECT * FROM engagement WHERE id = ?')
    .get(id) as EngagementRow;
}

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-liveness-stop-'));
  resetSessionDb();
  initSessionDb(resolve(testDir, 'test.db'));
});

afterEach(async () => {
  closeSessionDb();
  await rm(testDir, { recursive: true, force: true });
});

describe('livenessStopSession', () => {
  it('closes the captured open engagement with liveness_gc + snapshot and stops the session', async () => {
    const e1 = await seedActiveWithEngagement('sess-1');

    const stopped = livenessStopSession({
      sessionId: 'sess-1',
      engagementId: e1.id,
      engagementStartedAt: e1.started_at,
      endedAt: '2026-06-24T09:00:00.000Z',
      tokensAtClose: snap(500),
    });

    expect(stopped).toBe(true);
    const closed = engagementById(e1.id);
    expect(closed.close_reason).toBe('liveness_gc');
    expect(closed.ended_at).toBe('2026-06-24T09:00:00.000Z');
    expect(JSON.parse(closed.tokens_at_close!).models['claude-opus'].total).toBe(500);
    expect(getSessionById('sess-1')!.status).toBe('stopped');
    expect(getSessionById('sess-1')!.ended).toBe('2026-06-24T09:00:00.000Z');
  });

  it('is a no-op on a second call (captured interval already closed)', async () => {
    const e1 = await seedActiveWithEngagement('sess-1');
    livenessStopSession({
      sessionId: 'sess-1',
      engagementId: e1.id,
      engagementStartedAt: e1.started_at,
      endedAt: '2026-06-24T09:00:00.000Z',
      tokensAtClose: snap(500),
    });

    const second = livenessStopSession({
      sessionId: 'sess-1',
      engagementId: e1.id,
      engagementStartedAt: e1.started_at,
      endedAt: '2026-06-24T09:30:00.000Z',
      tokensAtClose: snap(999),
    });

    expect(second).toBe(false);
    const closed = engagementById(e1.id);
    // Unchanged by the second call — still the first close's reason/ts/tokens.
    expect(closed.close_reason).toBe('liveness_gc');
    expect(closed.ended_at).toBe('2026-06-24T09:00:00.000Z');
    expect(JSON.parse(closed.tokens_at_close!).models['claude-opus'].total).toBe(500);
  });

  it('stops a session that has no open engagement (no engagementId captured)', async () => {
    await appendSession('', makeSession({ sessionId: 'sess-1' }));
    // No engagement at all for this session.
    expect(getOpenEngagement('sess-1')).toBeNull();

    const stopped = livenessStopSession({
      sessionId: 'sess-1',
      endedAt: '2026-06-24T09:00:00.000Z',
    });

    expect(stopped).toBe(true);
    expect(getSessionById('sess-1')!.status).toBe('stopped');
  });

  it('genuine dead (no reopen): closes E1 with liveness_gc and stops the session', async () => {
    const e1 = await seedActiveWithEngagement('sess-1');

    const stopped = livenessStopSession({
      sessionId: 'sess-1',
      engagementId: e1.id,
      engagementStartedAt: e1.started_at,
      endedAt: '2026-06-24T09:00:00.000Z',
      tokensAtClose: snap(500),
    });

    expect(stopped).toBe(true);
    expect(engagementById(e1.id).close_reason).toBe('liveness_gc');
    expect(getSessionById('sess-1')!.status).toBe('stopped');
  });

  it('race: a reopen before the GC leaves E2 open AND the session active', async () => {
    const e1 = await seedActiveWithEngagement('sess-1');

    // A live command reopens/switches between the scanner capturing E1 as dead
    // and the GC running: E1 is closed ('switch') and a NEW E2 opened.
    const e2 = switchEngagement({
      sessionId: 'sess-1',
      projectSlug: 'proj',
      assignmentSlug: 'assn',
      stage: 'review',
      startedAt: '2026-06-24T08:30:00.000Z',
    });
    expect(e2.id).not.toBe(e1.id);

    // GC runs with the CAPTURED (stale) E1 identity.
    const stopped = livenessStopSession({
      sessionId: 'sess-1',
      engagementId: e1.id,
      engagementStartedAt: e1.started_at,
      endedAt: '2026-06-24T09:00:00.000Z',
      tokensAtClose: snap(500),
    });

    // The captured close no-ops (E1 was already closed by the switch) so the
    // session-stop is skipped: E2 stays OPEN and the session row stays active.
    expect(stopped).toBe(false);
    expect(engagementById(e1.id).close_reason).toBe('switch'); // NOT liveness_gc
    const open = getOpenEngagement('sess-1');
    expect(open).not.toBeNull();
    expect(open!.id).toBe(e2.id);
    expect(open!.ended_at).toBeNull();
    expect(getSessionById('sess-1')!.status).toBe('active');
  });

  it('idempotent recovery (AC4): a falsely-GCd live session reopens a fresh engagement next command', async () => {
    const e1 = await seedActiveWithEngagement('sess-1');
    livenessStopSession({
      sessionId: 'sess-1',
      engagementId: e1.id,
      engagementStartedAt: e1.started_at,
      endedAt: '2026-06-24T09:00:00.000Z',
      tokensAtClose: snap(500),
    });
    expect(getOpenEngagement('sess-1')).toBeNull();

    // The session was actually alive — its next command revives it.
    await appendSession(
      '',
      makeSession({ sessionId: 'sess-1', projectSlug: 'proj', assignmentSlug: 'assn' }),
      { reviveStopped: true },
    );

    const open = getOpenEngagement('sess-1');
    expect(open).not.toBeNull();
    expect(open!.id).not.toBe(e1.id);
    expect(getSessionById('sess-1')!.status).toBe('active');
  });
});
