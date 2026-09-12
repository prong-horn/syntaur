import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
  getSessionDb,
} from '../dashboard/session-db.js';
import { appendSession, touchSession } from '../dashboard/agent-sessions.js';
import { getOpenEngagement } from '../db/engagement-db.js';
import { sweepStaleSessions } from '../sessions/stale-sweep.js';
import type { AgentSession } from '../dashboard/types.js';

/**
 * The stale sweep (phase 4, Decision 4) — the whole of what replaced the
 * transcript scanner's `lsof` + mtime + Agent-View liveness.
 */

let testDir: string;
let prevHome: string | undefined;

const HOUR = 60 * 60 * 1000;
/**
 * A fixed "now", pinned to the REAL clock. The sweep compares against
 * `updated_at`, and `touchSession` writes SQLite's `datetime('now')` — so a
 * hard-coded date in the future would make a fresh touch look older than a
 * seeded row and invert every assertion here.
 */
const NOW = Date.now();
const now = () => NOW;

/** SQLite's own `YYYY-MM-DD HH:MM:SS` shape, `ageMs` before NOW. */
function stamp(ageMs: number): string {
  return new Date(NOW - ageMs).toISOString().replace('T', ' ').slice(0, 19);
}

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    projectSlug: null,
    ticketSlug: null,
    agent: 'claude',
    sessionId: `sess-${Math.random().toString(36).slice(2, 10)}`,
    started: '2026-09-03T06:00:00.000Z',
    status: 'active',
    path: '/w/repo',
    ...overrides,
  };
}

/** Register a row and force its `updated_at` to a chosen age. */
async function seed(overrides: Partial<AgentSession>, ageMs: number): Promise<string> {
  const s = session(overrides);
  await appendSession('', s);
  getSessionDb()
    .prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?')
    .run(stamp(ageMs), s.sessionId);
  return s.sessionId;
}

const statusOf = (sessionId: string): string =>
  (
    getSessionDb().prepare('SELECT status FROM sessions WHERE session_id = ?').get(sessionId) as {
      status: string;
    }
  ).status;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-sweep-'));
  prevHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = resolve(testDir, 'home');
  resetSessionDb();
  initSessionDb(resolve(testDir, 'syntaur.db'));
});

afterEach(async () => {
  closeSessionDb();
  if (prevHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = prevHome;
  await rm(testDir, { recursive: true, force: true });
});

describe('sweepStaleSessions', () => {
  it('stops an active row idle longer than the window', async () => {
    const stale = await seed({}, 7 * HOUR);
    const result = await sweepStaleSessions({ idleMs: 6 * HOUR, now });
    expect(result.swept).toEqual([stale]);
    expect(statusOf(stale)).toBe('stopped');
  });

  it('closes the swept row’s open engagement with reason `stale-sweep`', async () => {
    const stale = await seed(
      { projectSlug: 'syntaur-meta', ticketSlug: 'demo', ticketId: 'DEM-1' },
      7 * HOUR,
    );
    expect(getOpenEngagement(stale)).not.toBeNull();

    const result = await sweepStaleSessions({ idleMs: 6 * HOUR, now });
    expect(result.engagementsClosed).toBe(1);
    expect(getOpenEngagement(stale)).toBeNull();

    const closed = getSessionDb()
      .prepare('SELECT close_reason, ended_at FROM engagement WHERE session_id = ?')
      .get(stale) as { close_reason: string; ended_at: string };
    expect(closed.close_reason).toBe('stale-sweep');
    // Closed at the row's own last-seen stamp, not at "now" — a swept session
    // must not claim to have run through the whole idle window.
    expect(closed.ended_at).toBe(new Date(NOW - 7 * HOUR).toISOString().replace('T', ' ').slice(0, 19).replace(' ', 'T') + 'Z');
  });

  it('leaves a row touched inside the window alone', async () => {
    const fresh = await seed({}, 7 * HOUR);
    // The heartbeat the PostToolUse / UserPromptSubmit hooks provide.
    touchSession(fresh);

    const result = await sweepStaleSessions({ idleMs: 6 * HOUR, now });
    expect(result.swept).toEqual([]);
    expect(statusOf(fresh)).toBe('active');
  });

  it('never touches an `acp` chat row, however idle — the broker owns it', async () => {
    const chat = await seed({ hostedBy: 'acp' }, 30 * HOUR);
    const result = await sweepStaleSessions({ idleMs: 6 * HOUR, now });
    expect(result.swept).toEqual([]);
    expect(statusOf(chat)).toBe('active');
  });

  it('leaves an already-stopped row alone', async () => {
    const stopped = await seed({ status: 'stopped' }, 30 * HOUR);
    const result = await sweepStaleSessions({ idleMs: 6 * HOUR, now });
    expect(result.swept).toEqual([]);
    expect(statusOf(stopped)).toBe('stopped');
  });

  it('honours the configured window', async () => {
    const id = await seed({}, 3 * HOUR);
    // Inside a 6 h window...
    expect((await sweepStaleSessions({ idleMs: 6 * HOUR, now })).swept).toEqual([]);
    // ...outside a 2 h one.
    expect((await sweepStaleSessions({ idleMs: 2 * HOUR, now })).swept).toEqual([id]);
  });

  it('sweeps several rows in one pass and reports each', async () => {
    const a = await seed({}, 7 * HOUR);
    const b = await seed({}, 12 * HOUR);
    await seed({ hostedBy: 'acp' }, 12 * HOUR);
    await seed({}, 1 * HOUR);

    const result = await sweepStaleSessions({ idleMs: 6 * HOUR, now });
    expect(result.swept.sort()).toEqual([a, b].sort());
  });
});

describe('touchSession', () => {
  it('moves updated_at and reports the write', async () => {
    const id = await seed({}, 7 * HOUR);
    const before = (
      getSessionDb().prepare('SELECT updated_at FROM sessions WHERE session_id = ?').get(id) as {
        updated_at: string;
      }
    ).updated_at;

    expect(touchSession(id)).toBe(true);

    const after = (
      getSessionDb().prepare('SELECT updated_at FROM sessions WHERE session_id = ?').get(id) as {
        updated_at: string;
      }
    ).updated_at;
    expect(after > before).toBe(true);
  });

  it('is a no-op for an id we do not track — it never creates a row', () => {
    expect(touchSession('not-a-session')).toBe(false);
    const count = (
      getSessionDb().prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
    ).n;
    expect(count).toBe(0);
  });
});

describe('the `session touch` command (the hook entry point)', () => {
  it('touches the session the hook payload names', async () => {
    const { runSessionTouch } = await import('../commands/session.js');
    const id = await seed({}, 7 * HOUR);
    const before = (
      getSessionDb().prepare('SELECT updated_at FROM sessions WHERE session_id = ?').get(id) as {
        updated_at: string;
      }
    ).updated_at;

    const result = await runSessionTouch(
      JSON.stringify({ session_id: id, cwd: '/w/repo', transcript_path: '/t/x.jsonl' }),
    );
    expect(result).toEqual({ touched: true, sessionId: id });

    const after = (
      getSessionDb().prepare('SELECT updated_at FROM sessions WHERE session_id = ?').get(id) as {
        updated_at: string;
      }
    ).updated_at;
    expect(after > before).toBe(true);

    // …and the row that WOULD have been swept now survives the pass.
    expect((await sweepStaleSessions({ idleMs: 6 * HOUR, now })).swept).toEqual([]);
  });

  it('is a no-op on garbage, an unsafe id, or an untracked session — never throws', async () => {
    const { runSessionTouch } = await import('../commands/session.js');
    expect(await runSessionTouch('')).toEqual({ touched: false, sessionId: null });
    expect(await runSessionTouch('not json')).toEqual({ touched: false, sessionId: null });
    expect(await runSessionTouch(JSON.stringify({ session_id: '../../etc/passwd' }))).toEqual({
      touched: false,
      sessionId: null,
    });
    expect(await runSessionTouch(JSON.stringify({ session_id: 'never-registered' }))).toEqual({
      touched: false,
      sessionId: 'never-registered',
    });
  });
});
