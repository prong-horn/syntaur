import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { initSessionDb, getSessionDb, resetSessionDb, closeSessionDb } from '../../../dashboard/session-db.js';
import { loadSessions, liveOnly, resetAgentViewGrace } from '../feed.js';
import type { AgentConfig } from '../../../utils/config.js';
import type { AgentViewDetailEntry } from '../../../sessions/agent-view.js';

let dir: string;
const agents: AgentConfig[] = [{ id: 'claude', label: 'Claude', command: 'claude' } as AgentConfig];

beforeEach(() => {
  resetSessionDb();
  resetAgentViewGrace();
  dir = mkdtempSync(resolve(tmpdir(), 'syntaur-feed-'));
  initSessionDb(resolve(dir, 'syntaur.db'));
});
afterEach(() => { closeSessionDb(); rmSync(dir, { recursive: true, force: true }); });

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
