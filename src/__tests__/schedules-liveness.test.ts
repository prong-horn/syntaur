import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { initSessionDb, closeSessionDb, resetSessionDb } from '../dashboard/session-db.js';
import { appendSession } from '../dashboard/agent-sessions.js';
import type { AgentSession } from '../dashboard/types.js';
import { isScheduledSessionLive } from '../schedules/liveness.js';

let testDir: string;
let dbPath: string;

// A pid that is essentially never alive (process.kill(0) → ESRCH).
const DEAD_PID = 2_147_483_646;

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    projectSlug: null,
    assignmentSlug: null,
    agent: 'claude',
    sessionId: `sess-${Math.random().toString(36).slice(2, 10)}`,
    started: '2026-06-15T00:00:00Z',
    status: 'active',
    path: '/tmp/test',
    ...overrides,
  };
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-liveness-test-'));
  dbPath = resolve(testDir, 'test.db');
  resetSessionDb();
  initSessionDb(dbPath);
});

afterEach(async () => {
  closeSessionDb();
  await rm(testDir, { recursive: true, force: true });
});

describe('isScheduledSessionLive', () => {
  it('returns true for a registered session whose pid is alive', async () => {
    // `process.pid` is the running test process → genuinely alive. No
    // pidStartedAt → no start-time guard, so computeIsLive trusts the pid.
    const session = makeSession({ pid: process.pid });
    await appendSession('', session);
    expect(isScheduledSessionLive(session.sessionId, null)).toBe(true);
  });

  it('returns false for a registered session whose pid is dead', async () => {
    const session = makeSession({ pid: DEAD_PID });
    await appendSession('', session);
    expect(isScheduledSessionLive(session.sessionId, null)).toBe(false);
  });

  it('returns false for a recycled pid (start-time mismatch)', async () => {
    // pid is alive (this process) but the stored start time differs from the
    // real one → computeIsLive treats it as a different (recycled) process.
    const session = makeSession({
      pid: process.pid,
      pidStartedAt: 'Thu Jan  1 00:00:00 1970',
    });
    await appendSession('', session);
    expect(isScheduledSessionLive(session.sessionId, null)).toBe(false);
  });

  it('returns true for a known session id with no registry row yet', () => {
    // The row may not be written right after launch-ack — treat as live/unknown.
    // Never fall back to a (possibly dead wrapper) launchPid here.
    expect(isScheduledSessionLive('not-in-db', DEAD_PID)).toBe(true);
  });

  it('returns true for a null session with a live launchPid', () => {
    expect(isScheduledSessionLive(null, process.pid)).toBe(true);
  });

  it('returns false for a null session with a dead launchPid', () => {
    expect(isScheduledSessionLive(null, DEAD_PID)).toBe(false);
  });

  it('returns true for a null session with a null launchPid (unknown)', () => {
    expect(isScheduledSessionLive(null, null)).toBe(true);
  });
});
