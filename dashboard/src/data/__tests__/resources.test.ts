import { describe, expect, it } from 'vitest';
import {
  apiUrl,
  invalidationsForMessage,
  matchesTarget,
  resources,
  ticketWriteTargets,
  validScopeId,
} from '../resources';

describe('resource descriptors', () => {
  it('encodes path segments and sorts query keys; omits undefined, keeps empty/false/zero', () => {
    expect(apiUrl(['tickets', 'a/b c'])).toBe('/api/tickets/a%2Fb%20c');
    expect(apiUrl(['x'], { z: '1', a: '', m: 0, f: false, u: undefined, n: null })).toBe('/api/x?a=&f=false&m=0&z=1');
    expect(apiUrl(['x'], { tag: ['b', 'a'] })).toBe('/api/x?tag=b&tag=a');
  });

  it('produces identical keys for equivalent inputs regardless of property order', () => {
    const a = resources.sessions({ page: 2, pageSize: 25, search: 'x', sort: 'started-desc' as never });
    const b = resources.sessions({ sort: 'started-desc' as never, search: 'x', pageSize: 25, page: 2 });
    expect(a.url).toBe(b.url);
    expect(resources.sessions({}).url).toBe('/api/agent-sessions');
    expect(resources.sessions({ archived: 'hide' }).url).toBe('/api/agent-sessions');
    expect(resources.inbox({ maxAgeDays: 0 }).url).toBe('/api/inbox');
    expect(resources.inbox({ maxAgeDays: 7, project: 'p1', includeSnoozed: true }).url).toBe(
      '/api/inbox?includeSnoozed=1&maxAgeDays=7&project=p1',
    );
  });

  it('carries typed metadata and tags rather than relying on URL substrings', () => {
    const detail = resources.ticket('SV-12');
    expect(detail.meta).toEqual({ kind: 'ticket-detail', ticketId: 'SV-12' });
    expect(detail.tags).toContain('metrics');
    // A ticket id that is a prefix of another must not match by substring.
    expect(matchesTarget(resources.ticket('SV-120'), { tag: 'ticket', ticketId: 'SV-12' })).toBe(false);
    expect(matchesTarget(detail, { tag: 'ticket', ticketId: 'SV-12' })).toBe(true);
    expect(matchesTarget(resources.ticketEvents('SV-12'), { tag: 'ticket', ticketId: 'SV-12' })).toBe(true);
    expect(matchesTarget(resources.tickets(), { tag: 'ticket', ticketId: 'SV-12' })).toBe(false);
    expect(matchesTarget(resources.config('theme'), { tag: 'config', configKind: 'search' })).toBe(false);
  });

  it('rejects document URLs outside /api', () => {
    expect(() => resources.document('https://evil.example/x')).toThrow();
    expect(resources.document('/api/tickets/T-1/files/plan.md').tags).toEqual(['document']);
  });

  it('validates scope ids before targeted matching', () => {
    expect(validScopeId('SV-12')).toBe('SV-12');
    expect(validScopeId('0b4c-uuid')).toBe('0b4c-uuid');
    expect(validScopeId('../etc')).toBeUndefined();
    expect(validScopeId('')).toBeUndefined();
    expect(validScopeId(42)).toBeUndefined();
  });
});

describe('websocket invalidation matrix', () => {
  const targetsFor = (m: Parameters<typeof invalidationsForMessage>[0]) =>
    invalidationsForMessage(m).map((t) => [t.tag, t.ticketId ?? t.projectSlug ?? t.configKind ?? '*'].join(':'));

  it('scopes ticket-updated to the ticket and project, plus board, rollups and inbox', () => {
    expect(targetsFor({ type: 'ticket-updated', ticketId: 'SV-12', projectSlug: 'p1', timestamp: 't' })).toEqual([
      'ticket:SV-12',
      'board:*',
      'projects:*',
      'project:p1',
      'archived:*',
      'inbox:*',
      'search:*',
    ]);
  });

  it('broadens conservatively when the ticket id is missing or invalid', () => {
    const t = targetsFor({ type: 'ticket-updated', ticketId: '../x', timestamp: 't' });
    expect(t).toContain('ticket:*');
    expect(t).toContain('project:*');
  });

  it('routes stage-dispatch by payload.ticketId to that detail and the inbox only', () => {
    expect(targetsFor({ type: 'stage-dispatch', payload: { ticketId: 'T-1', requestId: 'r' }, timestamp: 't' })).toEqual([
      'ticket-detail:T-1',
      'inbox:*',
    ]);
  });

  it('does not invalidate anything on chat deltas or the connected frame', () => {
    expect(invalidationsForMessage({ type: 'chat-item', payload: { ticketId: 'T-1' }, timestamp: 't' })).toEqual([]);
    expect(invalidationsForMessage({ type: 'chat-session', payload: { ticketId: 'T-1' }, timestamp: 't' })).toEqual([]);
    expect(invalidationsForMessage({ type: 'connected', timestamp: 't' })).toEqual([]);
  });

  it('scopes chat-participants to agents plus that ticket (never the board)', () => {
    expect(targetsFor({ type: 'chat-participants', payload: { ticketId: 'T-9' }, timestamp: 't' })).toEqual([
      'agents:*',
      'ticket-detail:T-9',
    ]);
  });

  it('maps session DB, agents, templates and config notifications to their families', () => {
    expect(targetsFor({ type: 'agent-sessions-updated', timestamp: 't' })).toEqual([
      'sessions:*',
      'usage:*',
      'metrics:*',
    ]);
    expect(targetsFor({ type: 'agents-updated', timestamp: 't' })).toEqual(['agents:*', 'ticket-detail:*']);
    expect(targetsFor({ type: 'templates-updated', timestamp: 't' })).toEqual(['templates:*', 'board:*', 'ticket-detail:*']);
    expect(targetsFor({ type: 'config-updated', payload: { kind: 'view-prefs' }, timestamp: 't' })).toEqual(['view-prefs:*']);
    expect(targetsFor({ type: 'config-updated', payload: { kind: 'config' }, timestamp: 't' })).toEqual(['config:*']);
    expect(targetsFor({ type: 'playbooks-updated', timestamp: 't' })).toEqual(['playbooks:*']);
  });

  it('ticket writes invalidate ticket, board, project, inbox and search', () => {
    const tags = ticketWriteTargets('T-1', 'p').map((t) => t.tag);
    for (const tag of ['ticket', 'board', 'project', 'projects', 'inbox', 'search']) expect(tags).toContain(tag);
  });
});
