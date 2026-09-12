// Pure, React-free routing for the "recreate a deleted worktree" flow. Kept
// dependency-free so the backend Vitest suite (which already imports other
// dashboard/src/lib helpers) can unit-test the request routing without a
// frontend test runner.

/** Identity carried by a recreate request — enough to route the POST. */
export interface RecreateIdentity {
  kind: 'ticket' | 'session';
  id: string;
  projectSlug: string | null;
  ticketSlug: string | null;
}

/**
 * Resolve the server-authoritative recreate endpoint for an identity. The
 * server re-derives the path/repo/branch from persisted state, so the request
 * carries no path — only the route identifies the target:
 *   - session -> /api/agent-sessions/:id/worktree/recreate
 *   - ticket  -> /api/tickets/:id/worktree/recreate
 */
export function recreateRequest(identity: RecreateIdentity): {
  method: 'POST';
  url: string;
} {
  if (identity.kind === 'session') {
    return {
      method: 'POST',
      url: `/api/agent-sessions/${encodeURIComponent(identity.id)}/worktree/recreate`,
    };
  }
  return {
    method: 'POST',
    url: `/api/tickets/${encodeURIComponent(identity.id)}/worktree/recreate`,
  };
}
