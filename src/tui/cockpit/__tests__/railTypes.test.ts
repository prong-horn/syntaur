import { describe, it, expect } from 'vitest';
import { buildRailRows, formatAge, type RailSessionRow } from '../railTypes.js';
import type { AgentSessionWithLiveness } from '../../../dashboard/types.js';

const NOW = Date.parse('2026-07-03T12:00:00Z');

function session(overrides: Partial<AgentSessionWithLiveness> = {}): AgentSessionWithLiveness {
  return {
    sessionId: 'abcdef1234567890',
    agent: 'claude',
    started: '2026-07-03T11:58:00Z',
    status: 'active',
    isLive: true,
    resumeSupported: true,
    forkSupported: false,
    projectSlug: null,
    assignmentSlug: null,
    path: '/tmp/abcdef1234567890',
    ...overrides,
  } as AgentSessionWithLiveness;
}

describe('formatAge', () => {
  it('shows <1m under a minute', () => {
    expect(formatAge(30_000)).toBe('<1m');
  });
  it('shows whole minutes under an hour', () => {
    expect(formatAge(5 * 60_000)).toBe('5m');
  });
  it('shows whole hours under a day', () => {
    expect(formatAge(3 * 3600_000)).toBe('3h');
  });
  it('shows whole days beyond that', () => {
    expect(formatAge(2 * 86400_000)).toBe('2d');
  });
});

describe('buildRailRows — agent column (AC2: "agent · assignment/project or description · current activity · recency")', () => {
  it('carries the session agent separately from the work label', () => {
    const rows = buildRailRows([session({ agent: 'codex', projectSlug: 'proj', assignmentSlug: 'a1' })], { recentExpanded: false, now: NOW });
    const row = rows.find((r) => r.kind === 'session') as RailSessionRow;
    expect(row.agent).toBe('codex');
    expect(row.label).toBe('proj/a1');
  });
});

describe('buildRailRows — label resolution (never a bare UUID)', () => {
  it('prefers projectSlug/assignmentSlug when both are present', () => {
    const rows = buildRailRows([session({ projectSlug: 'proj', assignmentSlug: 'a1' })], { recentExpanded: false, now: NOW });
    const row = rows.find((r) => r.kind === 'session') as RailSessionRow;
    expect(row.label).toBe('proj/a1');
  });

  it('falls back to assignmentSlug alone with no projectSlug', () => {
    const rows = buildRailRows([session({ assignmentSlug: 'standalone' })], { recentExpanded: false, now: NOW });
    const row = rows.find((r) => r.kind === 'session') as RailSessionRow;
    expect(row.label).toBe('standalone');
  });

  it('falls back to description when there is no assignment binding', () => {
    const rows = buildRailRows([session({ description: 'ad-hoc exploration' })], { recentExpanded: false, now: NOW });
    const row = rows.find((r) => r.kind === 'session') as RailSessionRow;
    expect(row.label).toBe('ad-hoc exploration');
  });

  it('falls back to the basename of path when nothing else is set', () => {
    const rows = buildRailRows([session({ path: '/Users/brennen/syntaur/.worktrees/tui-cockpit-v2' })], { recentExpanded: false, now: NOW });
    const row = rows.find((r) => r.kind === 'session') as RailSessionRow;
    expect(row.label).toBe('tui-cockpit-v2');
  });

  it('never falls back to the bare session UUID', () => {
    const rows = buildRailRows([session({ path: '' })], { recentExpanded: false, now: NOW });
    const row = rows.find((r) => r.kind === 'session') as RailSessionRow;
    expect(row.label).not.toContain('abcdef1234567890');
  });
});

describe('buildRailRows — sort order and grouping', () => {
  it('sorts waiting before working before idle within LIVE', () => {
    const idle = session({ sessionId: 'idle', activity: 'idle', started: '2026-07-03T11:59:50Z' });
    const working = session({ sessionId: 'working', activity: 'working', started: '2026-07-03T11:59:00Z' });
    const waiting = session({ sessionId: 'waiting', waitingFor: 'permission prompt', started: '2026-07-03T11:00:00Z' });
    const rows = buildRailRows([idle, working, waiting], { recentExpanded: false, now: NOW });
    const sessionRows = rows.filter((r): r is RailSessionRow => r.kind === 'session');
    expect(sessionRows.map((r) => r.session.sessionId)).toEqual(['waiting', 'working', 'idle']);
  });

  it('surfaces waitingFor as a yellow ⚠ marker', () => {
    const rows = buildRailRows([session({ waitingFor: 'permission prompt' })], { recentExpanded: false, now: NOW });
    const row = rows.find((r) => r.kind === 'session') as RailSessionRow;
    expect(row.activityText).toBe('⚠ permission prompt');
    expect(row.isWaiting).toBe(true);
  });

  it('prefers the transcript-derived liveActivity phrase over the coarse working/idle state', () => {
    const s = session({ sessionId: 's1', activity: 'working' });
    const liveActivity = new Map([['s1', 'editing DetailPane.tsx']]);
    const rows = buildRailRows([s], { recentExpanded: false, now: NOW, liveActivity });
    const row = rows.find((r) => r.kind === 'session') as RailSessionRow;
    expect(row.activityText).toBe('editing DetailPane.tsx');
  });

  it('⚠ waitingFor still wins over a liveActivity phrase', () => {
    const s = session({ sessionId: 's1', waitingFor: 'permission prompt' });
    const liveActivity = new Map([['s1', 'editing DetailPane.tsx']]);
    const rows = buildRailRows([s], { recentExpanded: false, now: NOW, liveActivity });
    const row = rows.find((r) => r.kind === 'session') as RailSessionRow;
    expect(row.activityText).toBe('⚠ permission prompt');
  });

  it('collapses dead sessions behind a RECENT header when not expanded', () => {
    const dead = session({ sessionId: 'dead', isLive: false });
    const rows = buildRailRows([dead], { recentExpanded: false, now: NOW });
    expect(rows.some((r) => r.kind === 'session')).toBe(false);
    expect(rows.some((r) => r.kind === 'group-header' && r.group === 'recent' && r.label === 'RECENT (1)')).toBe(true);
  });

  it('reveals dead sessions (most-recent first) when RECENT is expanded', () => {
    const older = session({ sessionId: 'older', isLive: false, started: '2026-07-03T10:00:00Z' });
    const newer = session({ sessionId: 'newer', isLive: false, started: '2026-07-03T11:59:00Z' });
    const rows = buildRailRows([older, newer], { recentExpanded: true, now: NOW });
    const sessionRows = rows.filter((r): r is RailSessionRow => r.kind === 'session');
    expect(sessionRows.map((r) => r.session.sessionId)).toEqual(['newer', 'older']);
  });

  it('caps the expanded RECENT list and appends a "…and N more" row', () => {
    const dead = Array.from({ length: 25 }, (_, i) => session({ sessionId: `dead-${i}`, isLive: false, started: '2026-07-03T11:00:00Z' }));
    const rows = buildRailRows(dead, { recentExpanded: true, now: NOW });
    const sessionRows = rows.filter((r) => r.kind === 'session');
    expect(sessionRows).toHaveLength(20);
    const more = rows.find((r) => r.kind === 'more');
    expect(more).toEqual({ kind: 'more', count: 5 });
  });
});
