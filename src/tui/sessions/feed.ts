import { listAllSessions } from '../../dashboard/agent-sessions.js';
import { enrichSessions, type LivenessDeps } from '../../dashboard/session-liveness.js';
import { productionAgentViewDetailSource, type AgentViewDetailEntry, type AgentViewDetailSource } from '../../sessions/agent-view.js';
import type { AgentConfig } from '../../utils/config.js';
import type { ActivityState, AgentSessionWithLiveness, NativeAgentState } from '../../dashboard/types.js';

export interface LoadSessionsOptions {
  projectsDir: string;
  agents: AgentConfig[];
  livenessDeps?: LivenessDeps;
  /** Injectable for tests; defaults to the real `claude agents --json` probe. */
  agentViewDetailSource?: AgentViewDetailSource;
}

/** Non-terminal native states — the session is still doing something, or waiting on the user. */
const LIVE_STATES: ReadonlySet<NativeAgentState> = new Set(['working', 'blocked']);

function stateToActivity(state: NativeAgentState | null): ActivityState | null {
  switch (state) {
    case 'working':
      return 'working';
    case 'blocked':
      return 'awaiting-input';
    default:
      return null;
  }
}

// Last successfully-probed detail list, kept across polls so a single
// transient failure (daemon restart, CLI upgrade mid-flight) doesn't yank
// native state off the rail for one tick. Reset by `resetAgentViewGrace` in
// tests so cases don't leak state into each other.
let lastKnownDetail: AgentViewDetailEntry[] | null = null;
let graceSpent = false;

/** Test-only: clear the module-level grace cache between cases. */
export function resetAgentViewGrace(): void {
  lastKnownDetail = null;
  graceSpent = false;
}

/**
 * Resolve the detail entries to join this poll, applying the ≤1-poll grace
 * degradation: a probe failure (`null`) reuses the last successful list ONCE,
 * then degrades to `[]` (no native overlay — rows fall back to session-db
 * liveness) if the failure persists. A successful call — even an empty
 * list — always wins immediately and resets the grace counter, because an
 * empty `[]` is real information (the agents really did end), not a failure.
 */
async function resolveDetailEntries(source: AgentViewDetailSource): Promise<AgentViewDetailEntry[]> {
  let detail: AgentViewDetailEntry[] | null;
  try {
    detail = await source();
  } catch {
    detail = null; // never let a probe failure throw out of the poll
  }

  if (detail !== null) {
    lastKnownDetail = detail;
    graceSpent = false;
    return detail;
  }
  if (!graceSpent && lastKnownDetail !== null) {
    graceSpent = true;
    return lastKnownDetail;
  }
  lastKnownDetail = null;
  graceSpent = false;
  return [];
}

export async function loadSessions(opts: LoadSessionsOptions): Promise<AgentSessionWithLiveness[]> {
  const sessions = await listAllSessions(opts.projectsDir);
  const enriched = enrichSessions(sessions, opts.agents, opts.livenessDeps);

  const source = opts.agentViewDetailSource ?? productionAgentViewDetailSource;
  const detail = await resolveDetailEntries(source);
  if (detail.length === 0) return enriched;

  const bySessionId = new Map(detail.map((d) => [d.sessionId, d]));
  return enriched.map((s) => {
    const d = bySessionId.get(s.sessionId);
    if (!d) return s;
    return {
      ...s,
      state: d.state,
      waitingFor: d.waitingFor,
      agentShortId: d.id,
      activity: stateToActivity(d.state) ?? s.activity,
      isLive: d.state != null ? LIVE_STATES.has(d.state) : s.isLive,
    };
  });
}

export function liveOnly(sessions: AgentSessionWithLiveness[]): AgentSessionWithLiveness[] {
  return sessions.filter((s) => s.isLive);
}
