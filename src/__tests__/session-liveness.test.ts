import { describe, expect, it } from 'vitest';
import {
  computeIsLive,
  enrichSession,
  enrichSessions,
  type LivenessDeps,
} from '../dashboard/session-liveness.js';
import type { AgentSession } from '../dashboard/types.js';
import type { AgentConfig } from '../utils/config.js';

const NOW = Date.UTC(2026, 4, 19, 12, 0, 0); // 2026-05-19T12:00:00Z

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sessionId: 's',
    projectSlug: null,
    assignmentSlug: null,
    agent: 'claude',
    started: '2026-05-19T11:00:00Z',
    status: 'active',
    path: '/tmp',
    description: null,
    transcriptPath: null,
    pid: null,
    pidStartedAt: null,
    ...overrides,
  };
}

function deps(overrides: LivenessDeps = {}): LivenessDeps {
  return {
    now: () => NOW,
    isPidAlive: () => false,
    pidStartedAt: () => null,
    statMtimeMs: () => null,
    ...overrides,
  };
}

describe('computeIsLive', () => {
  it('returns false when status is not active (manual override)', () => {
    expect(computeIsLive(makeSession({ status: 'stopped' }), deps())).toBe(false);
    expect(computeIsLive(makeSession({ status: 'completed' }), deps())).toBe(false);
  });

  it('returns true when pid is alive and start-time matches', () => {
    const s = makeSession({ pid: 1234, pidStartedAt: 'Mon May 19 07:00:00 2026' });
    const live = computeIsLive(
      s,
      deps({
        isPidAlive: (p) => p === 1234,
        pidStartedAt: () => 'Mon May 19 07:00:00 2026',
      }),
    );
    expect(live).toBe(true);
  });

  it('returns true when pid is alive and no stored start-time (no recycling check possible)', () => {
    const s = makeSession({ pid: 1234, pidStartedAt: null });
    const live = computeIsLive(
      s,
      deps({
        isPidAlive: () => true,
        // pidStartedAt fn would return something, but no stored baseline.
        pidStartedAt: () => 'Mon May 19 07:00:00 2026',
      }),
    );
    expect(live).toBe(true);
  });

  it('returns false when pid is not alive', () => {
    const s = makeSession({ pid: 99999, pidStartedAt: 'Mon May 19 07:00:00 2026' });
    expect(computeIsLive(s, deps({ isPidAlive: () => false }))).toBe(false);
  });

  it('returns false when pid is alive but start-time mismatches (recycled)', () => {
    const s = makeSession({ pid: 1234, pidStartedAt: 'Mon May 19 07:00:00 2026' });
    const live = computeIsLive(
      s,
      deps({
        isPidAlive: () => true,
        pidStartedAt: () => 'Mon May 19 11:30:00 2026', // different process
      }),
    );
    expect(live).toBe(false);
  });

  it('returns true when no pid but transcript mtime is fresh (<5min)', () => {
    const s = makeSession({ transcriptPath: '/tmp/t.jsonl' });
    const live = computeIsLive(
      s,
      deps({ statMtimeMs: () => NOW - 60_000 }), // 1 min ago
    );
    expect(live).toBe(true);
  });

  it('falls through to default-true when no pid AND mtime is stale', () => {
    const s = makeSession({ transcriptPath: '/tmp/t.jsonl' });
    const live = computeIsLive(
      s,
      deps({ statMtimeMs: () => NOW - 10 * 60_000 }), // 10 min ago
    );
    // Default tier: no signal → assume live so Resume is gated off.
    expect(live).toBe(true);
  });

  it('returns true by default when no pid AND no transcript', () => {
    const s = makeSession({ pid: null, transcriptPath: null });
    expect(computeIsLive(s, deps())).toBe(true);
  });

  it('returns true by default when transcript path is set but stat fails', () => {
    const s = makeSession({ transcriptPath: '/tmp/missing.jsonl' });
    expect(computeIsLive(s, deps({ statMtimeMs: () => null }))).toBe(true);
  });
});

const claudeAgent: AgentConfig = {
  id: 'claude',
  label: 'Claude',
  command: 'claude',
  resume: { args: ['--resume', '{id}'] },
  fork: { args: ['--resume', '{id}', '--fork-session'] },
};
const resumeOnlyAgent: AgentConfig = {
  id: 'resume-only',
  label: 'Resume-only',
  command: 'r',
  resume: { args: ['--resume', '{id}'] },
};

describe('enrichSession resumeSupported / forkSupported', () => {
  it('flags both true when agent has resume and fork', () => {
    const s = makeSession({ agent: 'claude' });
    const enriched = enrichSession(s, [claudeAgent], deps());
    expect(enriched.resumeSupported).toBe(true);
    expect(enriched.forkSupported).toBe(true);
  });

  it('flags forkSupported false when the agent lacks a fork entry', () => {
    const s = makeSession({ agent: 'resume-only' });
    const enriched = enrichSession(s, [resumeOnlyAgent], deps());
    expect(enriched.resumeSupported).toBe(true);
    expect(enriched.forkSupported).toBe(false);
  });

  it('flags both false when the session agent is not in the configured list', () => {
    const s = makeSession({ agent: 'mystery-agent' });
    const enriched = enrichSession(s, [claudeAgent], deps());
    expect(enriched.resumeSupported).toBe(false);
    expect(enriched.forkSupported).toBe(false);
  });
});

describe('enrichSessions', () => {
  it('enriches each row independently', () => {
    const rows = [
      makeSession({ sessionId: 'a', agent: 'claude', status: 'active' }),
      makeSession({ sessionId: 'b', agent: 'mystery', status: 'stopped' }),
    ];
    const out = enrichSessions(rows, [claudeAgent], deps());
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      sessionId: 'a',
      resumeSupported: true,
      forkSupported: true,
    });
    expect(out[1]).toMatchObject({
      sessionId: 'b',
      isLive: false, // status=stopped
      resumeSupported: false,
      forkSupported: false,
    });
  });
});
