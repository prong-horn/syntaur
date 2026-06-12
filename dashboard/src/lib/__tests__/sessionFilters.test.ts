import { describe, expect, it } from 'vitest';
import { filterSessions, sortSessions, applySessionLimit } from '../sessionFilters';
import type { AgentSessionWithLiveness } from '../../types';

function makeSession(overrides: Partial<AgentSessionWithLiveness> = {}): AgentSessionWithLiveness {
  return {
    projectSlug: null,
    assignmentSlug: null,
    agent: 'codex',
    sessionId: 'test-session',
    started: '2026-06-01T00:00:00Z',
    ended: null,
    status: 'active',
    path: '/tmp/test',
    description: null,
    transcriptPath: null,
    pid: null,
    pidStartedAt: null,
    originalHeadSha: null,
    updatedAt: '2026-06-01T00:00:00Z',
    isLive: true,
    resumeSupported: false,
    forkSupported: false,
    ...overrides,
  };
}

describe('filterSessions', () => {
  const sessions = [
    makeSession({ sessionId: 's1', projectSlug: 'syntaur', agent: 'codex', status: 'active', started: '2026-06-10T12:00:00Z' }),
    makeSession({ sessionId: 's2', projectSlug: 'other', agent: 'claude', status: 'completed', started: '2026-06-05T12:00:00Z' }),
    makeSession({ sessionId: 's3', projectSlug: null, agent: 'codex', status: 'stopped', started: '2026-06-01T12:00:00Z' }),
    makeSession({ sessionId: 's4', projectSlug: 'syntaur', agent: 'cursor', status: 'active', started: '2026-05-01T12:00:00Z' }),
  ];

  it('returns all sessions when no filters are provided', () => {
    const result = filterSessions(sessions, {});
    expect(result).toHaveLength(4);
  });

  it('filters by project slug', () => {
    const result = filterSessions(sessions, { project: ['syntaur'] });
    expect(result.map((s) => s.sessionId)).toEqual(['s1', 's4']);
  });

  it('filters by __standalone__ as projectSlug === null', () => {
    const result = filterSessions(sessions, { project: ['__standalone__'] });
    expect(result.map((s) => s.sessionId)).toEqual(['s3']);
  });

  it('filters by agent name (case-insensitive)', () => {
    const result = filterSessions(sessions, { agent: ['Codex', 'CURSOR'] });
    expect(result.map((s) => s.sessionId)).toEqual(['s1', 's3', 's4']);
  });

  it('filters by sessionStatus active', () => {
    const result = filterSessions(sessions, { sessionStatus: ['active'] });
    expect(result.map((s) => s.sessionId)).toEqual(['s1', 's4']);
  });

  it('filters by sessionStatus ended', () => {
    const result = filterSessions(sessions, { sessionStatus: ['ended'] });
    expect(result.map((s) => s.sessionId)).toEqual(['s2', 's3']);
  });

  it('filters by sessionStatus tracked (no-op, all pass)', () => {
    const result = filterSessions(sessions, { sessionStatus: ['tracked'] });
    expect(result).toHaveLength(4);
  });

  it('filters by sessionStatus untracked (MVP deferral → empty)', () => {
    // untracked requires scanner merge (deferred); it never matches a DB session.
    const result = filterSessions(sessions, { sessionStatus: ['untracked'] });
    expect(result).toHaveLength(0);
  });

  it('filters by dateRange preset last_7d relative to a fixed now', () => {
    const now = Date.parse('2026-06-12T00:00:00Z');
    const result = filterSessions(
      sessions,
      { dateRange: { field: 'started', preset: 'last_7d' } },
      now,
    );
    // s1 (Jun 10), s2 (Jun 5) are within last 7d of Jun 12
    expect(result.map((s) => s.sessionId)).toEqual(['s1', 's2']);
  });

  it('filters by dateRange preset older_30d', () => {
    const now = Date.parse('2026-06-12T00:00:00Z');
    const result = filterSessions(
      sessions,
      { dateRange: { field: 'started', preset: 'older_30d' } },
      now,
    );
    // s4 (May 1) is older than 30 days from Jun 12
    expect(result.map((s) => s.sessionId)).toEqual(['s4']);
  });

  it('filters by dateRange absolute from/to', () => {
    const result = filterSessions(sessions, {
      dateRange: { field: 'started', from: '2026-06-05', to: '2026-06-10' },
    });
    expect(result.map((s) => s.sessionId)).toEqual(['s1', 's2']);
  });

  it('combines multiple filters', () => {
    const result = filterSessions(sessions, {
      project: ['syntaur'],
      agent: ['codex'],
      sessionStatus: ['active'],
    });
    expect(result.map((s) => s.sessionId)).toEqual(['s1']);
  });
});

describe('sortSessions', () => {
  const sessions = [
    makeSession({ sessionId: 's1', agent: 'zebra', projectSlug: 'zoo', started: '2026-06-10T00:00:00Z', updatedAt: '2026-06-10T00:00:00Z' }),
    makeSession({ sessionId: 's2', agent: 'alpha', projectSlug: 'ark', started: '2026-06-01T00:00:00Z', updatedAt: '2026-06-05T00:00:00Z' }),
    makeSession({ sessionId: 's3', agent: 'beta', projectSlug: 'zoo', started: '2026-06-05T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z' }),
  ];

  it('sorts by started asc', () => {
    const result = sortSessions(sessions, 'started', 'asc');
    expect(result.map((s) => s.sessionId)).toEqual(['s2', 's3', 's1']);
  });

  it('sorts by started desc', () => {
    const result = sortSessions(sessions, 'started', 'desc');
    expect(result.map((s) => s.sessionId)).toEqual(['s1', 's3', 's2']);
  });

  it('sorts by lastActivity asc', () => {
    const result = sortSessions(sessions, 'lastActivity', 'asc');
    expect(result.map((s) => s.sessionId)).toEqual(['s3', 's2', 's1']);
  });

  it('sorts by projectName asc', () => {
    const result = sortSessions(sessions, 'projectName', 'asc');
    expect(result.map((s) => s.sessionId)).toEqual(['s2', 's1', 's3']);
  });

  it('sorts by agentName asc', () => {
    const result = sortSessions(sessions, 'agentName', 'asc');
    expect(result.map((s) => s.sessionId)).toEqual(['s2', 's3', 's1']);
  });

  it('falls back to started desc for unknown sortField', () => {
    const result = sortSessions(sessions, 'unknown' as any, 'asc');
    expect(result.map((s) => s.sessionId)).toEqual(['s2', 's3', 's1']);
  });
});

describe('applySessionLimit', () => {
  const sessions = [
    makeSession({ sessionId: 's1' }),
    makeSession({ sessionId: 's2' }),
    makeSession({ sessionId: 's3' }),
    makeSession({ sessionId: 's4' }),
    makeSession({ sessionId: 's5' }),
  ];

  it('returns all when limit is undefined', () => {
    expect(applySessionLimit(sessions, undefined)).toHaveLength(5);
  });

  it('returns all when limit is 0', () => {
    expect(applySessionLimit(sessions, 0)).toHaveLength(5);
  });

  it('returns all when limit is NaN', () => {
    expect(applySessionLimit(sessions, NaN)).toHaveLength(5);
  });

  it('caps at the given limit', () => {
    expect(applySessionLimit(sessions, 2)).toHaveLength(2);
    expect(applySessionLimit(sessions, 2).map((s) => s.sessionId)).toEqual(['s1', 's2']);
  });

  it('returns all when limit exceeds array length', () => {
    expect(applySessionLimit(sessions, 100)).toHaveLength(5);
  });
});
