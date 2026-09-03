import { describe, it, expect, vi } from 'vitest';
import { recreateRequest, type RecreateIdentity } from '../../dashboard/src/lib/recreate';

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
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      (globalThis as { fetch?: unknown }).fetch = original;
    }
  });
});
