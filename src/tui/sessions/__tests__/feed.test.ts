import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { initSessionDb, getSessionDb, resetSessionDb, closeSessionDb } from '../../../dashboard/session-db.js';
import { loadSessions, liveOnly } from '../feed.js';
import type { AgentConfig } from '../../../utils/config.js';

let dir: string;
const agents: AgentConfig[] = [{ id: 'claude', label: 'Claude', command: 'claude' } as AgentConfig];

beforeEach(() => {
  resetSessionDb();
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
    const s = await loadSessions({ projectsDir: dir, agents, livenessDeps: { isPidAlive: () => true, pidStartedAt: () => null } });
    expect(s).toHaveLength(1);
    expect(s[0].isLive).toBe(true);
  });
  it('liveOnly drops dead/terminal sessions', async () => {
    insert('dead', 'active', 9999);
    insert('done', 'completed', null);
    const s = await loadSessions({ projectsDir: dir, agents, livenessDeps: { isPidAlive: () => false } });
    expect(liveOnly(s)).toEqual([]);
  });
});
