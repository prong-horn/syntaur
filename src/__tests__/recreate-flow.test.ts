import { describe, it, expect, vi } from 'vitest';
import {
  continuationUrl,
  recreateRequest,
  type RecreateIdentity,
} from '../../dashboard/src/lib/recreate-flow';

describe('continuationUrl', () => {
  it('builds an assignment deep link with no mode', () => {
    expect(continuationUrl({ kind: 'assignment', id: 'abc 123' })).toBe(
      'syntaur://open?assignment=abc%20123',
    );
  });

  it('preserves mode=resume for a session', () => {
    expect(continuationUrl({ kind: 'session', id: 's1' }, 'resume')).toBe(
      'syntaur://open?session=s1&mode=resume',
    );
  });

  it('preserves mode=fork for a session (does not collapse to resume)', () => {
    expect(continuationUrl({ kind: 'session', id: 's1' }, 'fork')).toBe(
      'syntaur://open?session=s1&mode=fork',
    );
  });

  it('appends a fallback terminal override', () => {
    expect(continuationUrl({ kind: 'session', id: 's1' }, 'fork', 'kitty')).toBe(
      'syntaur://open?session=s1&mode=fork&terminal=kitty',
    );
    // Assignment + fallback (no mode).
    expect(continuationUrl({ kind: 'assignment', id: 'a1' }, undefined, 'wezterm')).toBe(
      'syntaur://open?assignment=a1&terminal=wezterm',
    );
  });

  it('appends &agent= for an assignment target (url-encoded)', () => {
    expect(
      continuationUrl({ kind: 'assignment', id: 'a1' }, undefined, undefined, 'claude e2e'),
    ).toBe('syntaur://open?assignment=a1&agent=claude%20e2e');
  });

  it('appends &agent= alongside a fallback terminal', () => {
    expect(
      continuationUrl({ kind: 'assignment', id: 'a1' }, undefined, 'wezterm', 'codex'),
    ).toBe('syntaur://open?assignment=a1&terminal=wezterm&agent=codex');
  });

  it('does NOT append agent for a session target (agent is pinned by the record)', () => {
    expect(continuationUrl({ kind: 'session', id: 's1' }, 'resume', undefined, 'codex')).toBe(
      'syntaur://open?session=s1&mode=resume',
    );
  });

  it('omits agent when no agentId is given', () => {
    expect(continuationUrl({ kind: 'assignment', id: 'a1' })).toBe(
      'syntaur://open?assignment=a1',
    );
  });

  it('appends &prompt= for an assignment (url-encoded), alongside agent', () => {
    expect(
      continuationUrl({ kind: 'assignment', id: 'a1' }, undefined, undefined, 'claude', '@assignment go'),
    ).toBe('syntaur://open?assignment=a1&agent=claude&prompt=%40assignment%20go');
  });

  it('emits an empty &prompt= (presence-significant clear)', () => {
    expect(
      continuationUrl({ kind: 'assignment', id: 'a1' }, undefined, undefined, undefined, ''),
    ).toBe('syntaur://open?assignment=a1&prompt=');
  });

  it('omits prompt when undefined', () => {
    expect(
      continuationUrl({ kind: 'assignment', id: 'a1' }, undefined, undefined, undefined, undefined),
    ).toBe('syntaur://open?assignment=a1');
  });

  it('does NOT append prompt for a session target', () => {
    expect(
      continuationUrl({ kind: 'session', id: 's1' }, 'resume', undefined, undefined, '@assignment go'),
    ).toBe('syntaur://open?session=s1&mode=resume');
  });
});

describe('recreateRequest', () => {
  it('routes a project-nested assignment to the project recreate endpoint', () => {
    const id: RecreateIdentity = {
      kind: 'assignment',
      id: 'uuid-1',
      projectSlug: 'proj',
      assignmentSlug: 'task-x',
    };
    expect(recreateRequest(id)).toEqual({
      method: 'POST',
      url: '/api/projects/proj/assignments/task-x/worktree/recreate',
    });
  });

  it('routes a standalone assignment (no project) to the by-id endpoint', () => {
    const id: RecreateIdentity = {
      kind: 'assignment',
      id: 'uuid-2',
      projectSlug: null,
      assignmentSlug: null,
    };
    expect(recreateRequest(id)).toEqual({
      method: 'POST',
      url: '/api/assignments/uuid-2/worktree/recreate',
    });
  });

  it('routes a session to the agent-sessions recreate endpoint', () => {
    const id: RecreateIdentity = {
      kind: 'session',
      id: 'sess-9',
      projectSlug: 'p',
      assignmentSlug: 'a',
    };
    expect(recreateRequest(id)).toEqual({
      method: 'POST',
      url: '/api/agent-sessions/sess-9/worktree/recreate',
    });
  });

  it('is a pure descriptor builder — performs no network I/O (the No/cancel path makes no request)', () => {
    const fetchSpy = vi.fn();
    const original = (globalThis as { fetch?: unknown }).fetch;
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;
    try {
      // Building the descriptor (what a confirm would do) never fetches; a
      // cancel simply never calls this, so cancelling fires nothing.
      recreateRequest({ kind: 'session', id: 's', projectSlug: null, assignmentSlug: null });
      continuationUrl({ kind: 'session', id: 's' }, 'resume');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      (globalThis as { fetch?: unknown }).fetch = original;
    }
  });
});
