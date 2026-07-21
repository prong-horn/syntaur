import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { initSessionDb, getSessionDb, resetSessionDb, closeSessionDb } from '../../../dashboard/session-db.js';
import { loadSessions, liveOnly, resetAgentViewGrace, resetSyntaurdGrace } from '../feed.js';
import type { AgentConfig } from '../../../utils/config.js';
import type { AgentViewDetailEntry } from '../../../sessions/agent-view.js';
import type { SyntaurdFeedEntry } from '../../syntaurd/feed-source.js';

let dir: string;
let prevRuntimeDir: string | undefined;
const agents: AgentConfig[] = [{ id: 'claude', label: 'Claude', command: 'claude' } as AgentConfig];

beforeEach(() => {
  resetSessionDb();
  resetAgentViewGrace();
  resetSyntaurdGrace();
  dir = mkdtempSync(resolve(tmpdir(), 'syntaur-feed-'));
  // Point daemon discovery at the empty tmpdir: tests that do not inject a
  // syntaurdSessionSource hit the production source, which must resolve
  // "no daemon" deterministically — never a real daemon on this machine.
  prevRuntimeDir = process.env.SYNTAUR_RUNTIME_DIR;
  process.env.SYNTAUR_RUNTIME_DIR = dir;
  initSessionDb(resolve(dir, 'syntaur.db'));
});
afterEach(() => {
  closeSessionDb();
  if (prevRuntimeDir === undefined) delete process.env.SYNTAUR_RUNTIME_DIR;
  else process.env.SYNTAUR_RUNTIME_DIR = prevRuntimeDir;
  rmSync(dir, { recursive: true, force: true });
});

function insert(id: string, status: string, pid: number | null) {
  getSessionDb().prepare(
    "INSERT INTO sessions (session_id, agent, started, status, pid) VALUES (?, 'claude', datetime('now'), ?, ?)",
  ).run(id, status, pid);
}

describe('session feed', () => {
  it('loads sessions enriched with liveness', async () => {
    insert('s1', 'active', 4242);
    const s = await loadSessions({
      projectsDir: dir, agents,
      livenessDeps: { isPidAlive: () => true, pidStartedAt: () => null },
      agentViewDetailSource: async () => [],
    });
    expect(s).toHaveLength(1);
    expect(s[0].isLive).toBe(true);
  });
  it('liveOnly drops dead/terminal sessions', async () => {
    insert('dead', 'active', 9999);
    insert('done', 'completed', null);
    const s = await loadSessions({
      projectsDir: dir, agents,
      livenessDeps: { isPidAlive: () => false },
      agentViewDetailSource: async () => [],
    });
    expect(liveOnly(s)).toEqual([]);
  });
});

describe('session feed — native monitor join', () => {
  it('stamps state/waitingFor/agentShortId/activity from a matched detail entry', async () => {
    insert('s1', 'active', 4242);
    const detail: AgentViewDetailEntry[] = [
      { sessionId: 's1', id: 'ab12cd34', name: 'proj/a1', state: 'blocked', waitingFor: 'permission prompt' },
    ];
    const s = await loadSessions({
      projectsDir: dir, agents,
      livenessDeps: { isPidAlive: () => true, pidStartedAt: () => null },
      agentViewDetailSource: async () => detail,
    });
    expect(s[0].state).toBe('blocked');
    expect(s[0].waitingFor).toBe('permission prompt');
    expect(s[0].agentShortId).toBe('ab12cd34');
    expect(s[0].activity).toBe('awaiting-input');
    expect(s[0].launcher).toBe('claude-bg');
  });

  it('native state overrides pid-derived liveness (a native "done" session is not live even if the pid lingers)', async () => {
    insert('s1', 'active', 4242);
    const detail: AgentViewDetailEntry[] = [{ sessionId: 's1', id: 's1', name: null, state: 'done', waitingFor: null }];
    const s = await loadSessions({
      projectsDir: dir, agents,
      livenessDeps: { isPidAlive: () => true, pidStartedAt: () => null },
      agentViewDetailSource: async () => detail,
    });
    expect(s[0].isLive).toBe(false);
  });

  it('leaves session-db-derived liveness alone when there is no matching detail entry', async () => {
    insert('s1', 'active', 4242);
    const s = await loadSessions({
      projectsDir: dir, agents,
      livenessDeps: { isPidAlive: () => true, pidStartedAt: () => null },
      agentViewDetailSource: async () => [{ sessionId: 'other', id: 'x', name: null, state: 'working', waitingFor: null }],
    });
    expect(s[0].isLive).toBe(true);
    expect(s[0].state).toBeUndefined();
  });

  it('a successful empty list clears native state immediately (no grace)', async () => {
    insert('s1', 'active', 4242);
    const source = vi.fn(async (): Promise<AgentViewDetailEntry[]> => []);
    const s = await loadSessions({
      projectsDir: dir, agents,
      livenessDeps: { isPidAlive: () => true, pidStartedAt: () => null },
      agentViewDetailSource: source,
    });
    expect(s[0].state).toBeUndefined();
    expect(source).toHaveBeenCalledOnce();
  });

  it('probe failure (null) reuses last-known detail for exactly one poll, then degrades', async () => {
    insert('s1', 'active', 4242);
    const goodDetail: AgentViewDetailEntry[] = [{ sessionId: 's1', id: 'ab', name: null, state: 'working', waitingFor: null }];
    const livenessDeps = { isPidAlive: () => true, pidStartedAt: () => null };

    // Poll 1: success — populates the cache.
    const p1 = await loadSessions({ projectsDir: dir, agents, livenessDeps, agentViewDetailSource: async () => goodDetail });
    expect(p1[0].state).toBe('working');

    // Poll 2: probe failure — grace reuses poll 1's cached detail.
    const p2 = await loadSessions({ projectsDir: dir, agents, livenessDeps, agentViewDetailSource: async () => null });
    expect(p2[0].state).toBe('working');

    // Poll 3: probe failure AGAIN — grace is spent, degrades to session-db liveness.
    const p3 = await loadSessions({ projectsDir: dir, agents, livenessDeps, agentViewDetailSource: async () => null });
    expect(p3[0].state).toBeUndefined();
    expect(p3[0].isLive).toBe(true); // session-db/pid liveness, unaffected by native overlay
  });

  it('never throws when the detail source itself rejects', async () => {
    insert('s1', 'active', 4242);
    const s = await loadSessions({
      projectsDir: dir, agents,
      livenessDeps: { isPidAlive: () => true, pidStartedAt: () => null },
      agentViewDetailSource: async () => { throw new Error('boom'); },
    });
    expect(s).toHaveLength(1);
    expect(s[0].state).toBeUndefined();
  });
});

describe('session feed — syntaurd daemon join', () => {
  const livenessAlive = { isPidAlive: () => true, pidStartedAt: () => null };
  const livenessDead = { isPidAlive: () => false, pidStartedAt: () => null };
  const noNative = async () => [];

  function sdEntry(overrides: Partial<SyntaurdFeedEntry> = {}): SyntaurdFeedEntry {
    return {
      sessionId: 's1', short: 'sd12ab34', state: 'working', needs: null, name: 'proj/a1', agent: 'codex',
      ...overrides,
    };
  }

  it('stamps state/syntaurdShortId/launcher/activity from a matched daemon entry', async () => {
    insert('s1', 'active', 4242);
    const s = await loadSessions({
      projectsDir: dir, agents, livenessDeps: livenessAlive,
      agentViewDetailSource: noNative, syntaurdSessionSource: async () => [sdEntry()],
    });
    expect(s[0].state).toBe('working');
    expect(s[0].syntaurdShortId).toBe('sd12ab34');
    expect(s[0].launcher).toBe('syntaurd');
    expect(s[0].activity).toBe('working');
    expect(s[0].isLive).toBe(true);
  });

  it('daemon terminal state forces isLive=false over a lingering live pid', async () => {
    insert('s1', 'active', 4242);
    const s = await loadSessions({
      projectsDir: dir, agents, livenessDeps: livenessAlive,
      agentViewDetailSource: noNative, syntaurdSessionSource: async () => [sdEntry({ state: 'done' })],
    });
    expect(s[0].isLive).toBe(false);
  });

  it('daemon working state forces isLive=true over a dead pid', async () => {
    insert('s1', 'active', 99999);
    const s = await loadSessions({
      projectsDir: dir, agents, livenessDeps: livenessDead,
      agentViewDetailSource: noNative, syntaurdSessionSource: async () => [sdEntry()],
    });
    expect(s[0].isLive).toBe(true);
  });

  it('a blocked FIXTURE is live + awaiting-input (state handled; Phase A daemons never emit it)', async () => {
    insert('s1', 'active', 4242);
    const s = await loadSessions({
      projectsDir: dir, agents, livenessDeps: livenessAlive,
      agentViewDetailSource: noNative, syntaurdSessionSource: async () => [sdEntry({ state: 'blocked' })],
    });
    expect(s[0].isLive).toBe(true);
    expect(s[0].activity).toBe('awaiting-input');
  });

  it.each(['claude', 'codex', 'sh'])('a blocked %s daemon entry stamps needs, awaiting-input, and isLive (Phase C end-to-end)', async (agent) => {
    insert('s1', 'active', 4242);
    const s = await loadSessions({
      projectsDir: dir, agents, livenessDeps: livenessAlive,
      agentViewDetailSource: noNative,
      syntaurdSessionSource: async () => [sdEntry({ agent, state: 'blocked', needs: 'permission prompt' })],
    });
    expect(s[0].needs).toBe('permission prompt');
    expect(s[0].activity).toBe('awaiting-input');
    expect(s[0].isLive).toBe(true);
  });

  it('preserves the native waitingFor while ALSO stamping the daemon needs — both survive on the same row', async () => {
    insert('s1', 'active', 4242);
    const s = await loadSessions({
      projectsDir: dir, agents, livenessDeps: livenessAlive,
      agentViewDetailSource: async () => [{ sessionId: 's1', id: 'cc12dd34', name: null, state: 'blocked', waitingFor: 'native reason' }],
      syntaurdSessionSource: async () => [sdEntry({ state: 'blocked', needs: 'permission: Bash' })],
    });
    expect(s[0].waitingFor).toBe('native reason');
    expect(s[0].needs).toBe('permission: Bash');
    expect(s[0].agentShortId).toBe('cc12dd34');
    expect(s[0].syntaurdShortId).toBe('sd12ab34');
  });

  it('clears needs when the daemon reports the session no longer blocked', async () => {
    insert('s1', 'active', 4242);
    const s = await loadSessions({
      projectsDir: dir, agents, livenessDeps: livenessAlive,
      agentViewDetailSource: noNative,
      syntaurdSessionSource: async () => [sdEntry({ state: 'working', needs: null })],
    });
    expect(s[0].needs).toBeNull();
  });

  it('syntaurd join wins over the claude-view join on overlap, keeping agentShortId/waitingFor', async () => {
    insert('s1', 'active', 4242);
    const s = await loadSessions({
      projectsDir: dir, agents, livenessDeps: livenessAlive,
      agentViewDetailSource: async () => [{ sessionId: 's1', id: 'cc12dd34', name: null, state: 'working', waitingFor: null }],
      syntaurdSessionSource: async () => [sdEntry({ state: 'done' })],
    });
    expect(s[0].launcher).toBe('syntaurd');
    expect(s[0].state).toBe('done');
    expect(s[0].isLive).toBe(false);
    expect(s[0].agentShortId).toBe('cc12dd34');
    expect(s[0].syntaurdShortId).toBe('sd12ab34');
  });

  it('two sources, one feed: disjoint matches stamp independently', async () => {
    insert('s1', 'active', 4242);
    insert('s2', 'active', 4243);
    const s = await loadSessions({
      projectsDir: dir, agents, livenessDeps: livenessAlive,
      agentViewDetailSource: async () => [{ sessionId: 's2', id: 'cc12dd34', name: null, state: 'working', waitingFor: null }],
      syntaurdSessionSource: async () => [sdEntry({ sessionId: 's1' })],
    });
    const s1 = s.find((r) => r.sessionId === 's1');
    const s2 = s.find((r) => r.sessionId === 's2');
    expect(s1?.launcher).toBe('syntaurd');
    expect(s1?.syntaurdShortId).toBe('sd12ab34');
    expect(s2?.launcher).toBe('claude-bg');
    expect(s2?.agentShortId).toBe('cc12dd34');
    expect(s2?.syntaurdShortId).toBeUndefined();
  });

  it('unmatched rows are untouched by the daemon join', async () => {
    insert('s1', 'active', 4242);
    const s = await loadSessions({
      projectsDir: dir, agents, livenessDeps: livenessAlive,
      agentViewDetailSource: noNative, syntaurdSessionSource: async () => [sdEntry({ sessionId: 'other' })],
    });
    expect(s[0].state).toBeUndefined();
    expect(s[0].syntaurdShortId).toBeUndefined();
    expect(s[0].isLive).toBe(true);
  });

  it('a successful empty daemon list clears the overlay immediately (no grace)', async () => {
    insert('s1', 'active', 4242);
    const livenessDeps = livenessAlive;
    const p1 = await loadSessions({ projectsDir: dir, agents, livenessDeps, agentViewDetailSource: noNative, syntaurdSessionSource: async () => [sdEntry()] });
    expect(p1[0].syntaurdShortId).toBe('sd12ab34');
    const p2 = await loadSessions({ projectsDir: dir, agents, livenessDeps, agentViewDetailSource: noNative, syntaurdSessionSource: async () => [] });
    expect(p2[0].syntaurdShortId).toBeUndefined();
  });

  it('daemon probe failure (null) reuses last-known entries for exactly one poll, then degrades', async () => {
    insert('s1', 'active', 4242);
    const livenessDeps = livenessAlive;
    const p1 = await loadSessions({ projectsDir: dir, agents, livenessDeps, agentViewDetailSource: noNative, syntaurdSessionSource: async () => [sdEntry()] });
    expect(p1[0].syntaurdShortId).toBe('sd12ab34');
    const p2 = await loadSessions({ projectsDir: dir, agents, livenessDeps, agentViewDetailSource: noNative, syntaurdSessionSource: async () => null });
    expect(p2[0].syntaurdShortId).toBe('sd12ab34'); // grace
    const p3 = await loadSessions({ projectsDir: dir, agents, livenessDeps, agentViewDetailSource: noNative, syntaurdSessionSource: async () => null });
    expect(p3[0].syntaurdShortId).toBeUndefined(); // degraded to session-db-only
    expect(p3[0].isLive).toBe(true); // pid liveness back in charge — never crashed
  });

  it('a throwing daemon source never crashes the poll', async () => {
    insert('s1', 'active', 4242);
    const s = await loadSessions({
      projectsDir: dir, agents, livenessDeps: livenessAlive,
      agentViewDetailSource: noNative, syntaurdSessionSource: async () => { throw new Error('boom'); },
    });
    expect(s).toHaveLength(1);
    expect(s[0].syntaurdShortId).toBeUndefined();
  });

  it('the two grace caches are independent — one source succeeding does not refund the other`s spent grace', async () => {
    // A SHARED cache would pass a weaker version of this test, so the fixture is
    // built to discriminate: the syntaurd source succeeds on every poll while
    // the claude-view source fails from poll 2 on. With independent caches the
    // native grace is spent exactly once and poll 3 degrades. With a shared
    // cache, syntaurd's poll-2 success would reset the grace flag and poll 3
    // would wrongly serve native state again.
    insert('s1', 'active', 4242);
    const livenessDeps = livenessAlive;
    const nativeEntry = [{ sessionId: 's1', id: 'cc12dd34', name: null, state: 'working' as const, waitingFor: null }];

    // Poll 1: both sources succeed — both caches populated.
    const p1 = await loadSessions({
      projectsDir: dir, agents, livenessDeps,
      agentViewDetailSource: async () => nativeEntry, syntaurdSessionSource: async () => [sdEntry()],
    });
    expect(p1[0].agentShortId).toBe('cc12dd34');
    expect(p1[0].syntaurdShortId).toBe('sd12ab34');

    // Poll 2: native fails (spends ITS grace), syntaurd succeeds.
    const p2 = await loadSessions({
      projectsDir: dir, agents, livenessDeps,
      agentViewDetailSource: async () => null, syntaurdSessionSource: async () => [sdEntry()],
    });
    expect(p2[0].agentShortId).toBe('cc12dd34'); // native grace
    expect(p2[0].syntaurdShortId).toBe('sd12ab34');

    // Poll 3: native fails again — its grace is already spent, so it degrades
    // regardless of syntaurd's continued success.
    const p3 = await loadSessions({
      projectsDir: dir, agents, livenessDeps,
      agentViewDetailSource: async () => null, syntaurdSessionSource: async () => [sdEntry()],
    });
    expect(p3[0].agentShortId).toBeUndefined(); // fails if the caches were shared
    expect(p3[0].syntaurdShortId).toBe('sd12ab34'); // syntaurd unaffected throughout
  });

  it('a syntaurd failure does not spend the claude-view grace', async () => {
    // The mirror of the case above, in the other direction.
    insert('s1', 'active', 4242);
    const livenessDeps = livenessAlive;
    const nativeEntry = [{ sessionId: 's1', id: 'cc12dd34', name: null, state: 'working' as const, waitingFor: null }];

    await loadSessions({
      projectsDir: dir, agents, livenessDeps,
      agentViewDetailSource: async () => nativeEntry, syntaurdSessionSource: async () => [sdEntry()],
    });
    // Two consecutive syntaurd failures fully degrade the daemon overlay...
    await loadSessions({
      projectsDir: dir, agents, livenessDeps,
      agentViewDetailSource: async () => nativeEntry, syntaurdSessionSource: async () => null,
    });
    const p3 = await loadSessions({
      projectsDir: dir, agents, livenessDeps,
      agentViewDetailSource: async () => nativeEntry, syntaurdSessionSource: async () => null,
    });
    expect(p3[0].syntaurdShortId).toBeUndefined();
    // ...while the claude-view join keeps serving fresh state, ungraced.
    expect(p3[0].agentShortId).toBe('cc12dd34');
    expect(p3[0].launcher).toBe('claude-bg');
  });

  it('persisted hosted_by surfaces as hostedBy even when the daemon is down', async () => {
    getSessionDb().prepare(
      "INSERT INTO sessions (session_id, agent, started, status, pid, hosted_by) VALUES ('s1', 'codex', datetime('now'), 'active', 4242, 'syntaurd')",
    ).run();
    const s = await loadSessions({
      projectsDir: dir, agents, livenessDeps: livenessAlive,
      agentViewDetailSource: noNative, syntaurdSessionSource: async () => null,
    });
    expect(s[0].hostedBy).toBe('syntaurd');
    expect(s[0].syntaurdShortId).toBeUndefined();
  });
});
