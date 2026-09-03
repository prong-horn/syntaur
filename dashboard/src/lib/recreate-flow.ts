// The `syntaur://` continuation-URL half of the recreate flow. The routing
// half (`recreateRequest`) moved to `recreate.ts` because worktree recreation
// needs it and is not launch code; it is re-exported here so the launch-side
// components keep one import site.

export { recreateRequest, type RecreateIdentity } from './recreate';

export type ReopenMode = 'resume' | 'fork';

export type ContinuationTarget =
  | { kind: 'assignment'; id: string }
  | { kind: 'session'; id: string }
  | { kind: 'standalone'; id: string };

/**
 * Build the `syntaur://open` deep link to (re-)fire after preflight/recreate.
 * Sessions carry `&mode=resume|fork` so a fork never silently degrades into a
 * resume; assignments take no mode. An optional `fallbackTerminal` appends
 * `&terminal=` so a one-click "open in <fallback>" honors the override for that
 * single launch without mutating config. An optional `agentId` appends `&agent=`
 * for ASSIGNMENT targets only (so the "Open in agent" picker can launch a
 * specific runner profile); sessions pin their agent from the session record.
 * An optional `prompt` appends `&prompt=` for ASSIGNMENT and STANDALONE targets
 * — the editable launch box's (possibly edited) template, re-resolved
 * server-side. It is **presence-significant**: an empty string is a deliberate
 * override and is still emitted; `undefined` means "no override". An optional
 * `agentName` appends `&agentName=` for ASSIGNMENT targets only — a discovered
 * Claude agent identity (`--agent <name>`). Multi-line values are accepted and
 * percent-encoded normally. A `standalone` target emits
 * `syntaur://open?standalone=<id>` and identifies the agent by id.
 */
export function continuationUrl(
  target: ContinuationTarget,
  mode?: ReopenMode,
  fallbackTerminal?: string,
  agentId?: string,
  prompt?: string,
  agentName?: string,
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
  if (prompt !== undefined && (target.kind === 'assignment' || target.kind === 'standalone')) {
    url += `&prompt=${encodeURIComponent(prompt)}`;
  }
  if (agentName && target.kind === 'assignment') {
    url += `&agentName=${encodeURIComponent(agentName)}`;
  }
  return url;
}
