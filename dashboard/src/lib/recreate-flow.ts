// Pure, React-free helpers for the "recreate a deleted worktree" flow. Kept
// dependency-free so the backend Vitest suite (which already imports other
// dashboard/src/lib helpers) can unit-test the continuation-URL and request
// routing — including the side-effect-free Cancel path — without a frontend
// test runner.

export type ReopenMode = 'resume' | 'fork';

export type ContinuationTarget =
  | { kind: 'assignment'; id: string }
  | { kind: 'session'; id: string };

/**
 * Build the `syntaur://open` deep link to (re-)fire after preflight/recreate.
 * Sessions carry `&mode=resume|fork` so a fork never silently degrades into a
 * resume; assignments take no mode. An optional `fallbackTerminal` appends
 * `&terminal=` so a one-click "open in <fallback>" honors the override for that
 * single launch without mutating config. An optional `agentId` appends `&agent=`
 * for ASSIGNMENT targets only (so the "Open in agent" picker can launch a
 * specific runner profile); sessions pin their agent from the session record.
 * An optional `prompt` appends `&prompt=` for ASSIGNMENT targets only — the
 * editable launch box's (possibly edited) template, re-resolved server-side.
 * It is **presence-significant**: an empty string is a deliberate override and
 * is still emitted; `undefined` means "no override". Multi-line values are
 * accepted and percent-encoded normally.
 */
export function continuationUrl(
  target: ContinuationTarget,
  mode?: ReopenMode,
  fallbackTerminal?: string,
  agentId?: string,
  prompt?: string,
): string {
  let url = `syntaur://open?${target.kind}=${encodeURIComponent(target.id)}`;
  if (target.kind === 'session' && mode) {
    url += `&mode=${encodeURIComponent(mode)}`;
  }
  if (fallbackTerminal) {
    url += `&terminal=${encodeURIComponent(fallbackTerminal)}`;
  }
  if (agentId && target.kind === 'assignment') {
    url += `&agent=${encodeURIComponent(agentId)}`;
  }
  if (prompt !== undefined && target.kind === 'assignment') {
    url += `&prompt=${encodeURIComponent(prompt)}`;
  }
  return url;
}

/** Identity carried by a preflight `recreate` payload — enough to route the POST. */
export interface RecreateIdentity {
  kind: 'assignment' | 'session';
  id: string;
  projectSlug: string | null;
  assignmentSlug: string | null;
}

/**
 * Resolve the server-authoritative recreate endpoint for an identity. The
 * server re-derives the path/repo/branch from persisted state, so the request
 * carries no path — only the route identifies the target:
 *   - session            -> /api/agent-sessions/:id/worktree/recreate
 *   - project assignment -> /api/projects/:slug/assignments/:aslug/worktree/recreate
 *   - standalone          -> /api/assignments/:id/worktree/recreate
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
  if (identity.projectSlug && identity.assignmentSlug) {
    return {
      method: 'POST',
      url: `/api/projects/${encodeURIComponent(identity.projectSlug)}/assignments/${encodeURIComponent(identity.assignmentSlug)}/worktree/recreate`,
    };
  }
  return {
    method: 'POST',
    url: `/api/assignments/${encodeURIComponent(identity.id)}/worktree/recreate`,
  };
}
