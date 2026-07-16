import { listAllSessions } from '../../dashboard/agent-sessions.js';
import { enrichSessions, type LivenessDeps } from '../../dashboard/session-liveness.js';
import { productionAgentViewDetailSource, type AgentViewDetailEntry, type AgentViewDetailSource } from '../../sessions/agent-view.js';
import { productionSyntaurdSessionSource, type SyntaurdFeedEntry, type SyntaurdSessionSource } from '../syntaurd/feed-source.js';
import type { AgentConfig } from '../../utils/config.js';
import type { ActivityState, AgentSessionWithLiveness, NativeAgentState } from '../../dashboard/types.js';

export interface LoadSessionsOptions {
  projectsDir: string;
  agents: AgentConfig[];
  livenessDeps?: LivenessDeps;
  /** Injectable for tests; defaults to the real `claude agents --json` probe. */
  agentViewDetailSource?: AgentViewDetailSource;
  /** Injectable for tests; defaults to the real non-spawning daemon `{op:'list'}` poll. */
  syntaurdSessionSource?: SyntaurdSessionSource;
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

// Independent grace cache for the syntaurd daemon join — SEPARATE from the
// claude-view cache above so one source's failure never consumes the
// other's grace (two sources, one feed).
let lastKnownSyntaurd: SyntaurdFeedEntry[] | null = null;
let syntaurdGraceSpent = false;

/** Test-only: clear the syntaurd grace cache between cases. */
export function resetSyntaurdGrace(): void {
  lastKnownSyntaurd = null;
  syntaurdGraceSpent = false;
}

/** Same ≤1-poll grace contract as resolveDetailEntries above, for the daemon source. */
async function resolveSyntaurdEntries(source: SyntaurdSessionSource): Promise<SyntaurdFeedEntry[]> {
  let entries: SyntaurdFeedEntry[] | null;
  try {
    entries = await source();
  } catch {
    entries = null; // never let a probe failure throw out of the poll
  }

  if (entries !== null) {
    lastKnownSyntaurd = entries;
    syntaurdGraceSpent = false;
    return entries;
  }
  if (!syntaurdGraceSpent && lastKnownSyntaurd !== null) {
    syntaurdGraceSpent = true;
    return lastKnownSyntaurd;
  }
  lastKnownSyntaurd = null;
  syntaurdGraceSpent = false;
  return [];
}

/** The v2 claude-view overlay (unchanged semantics — moved out of loadSessions verbatim). */
function applyNativeJoin(
  enriched: AgentSessionWithLiveness[],
  detail: AgentViewDetailEntry[],
): AgentSessionWithLiveness[] {
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
      // A native monitor-join hit means the session IS being tracked by the
      // supervisor daemon, regardless of how it was originally started —
      // design spec §5.6: "launcher choice is per-session, recorded in the
      // feed row." Non-native sessions carry no reliable launcher signal
      // here, so their existing value (usually unset) is left alone.
      launcher: 'claude-bg' as const,
    };
  });
}

/**
 * Applied LAST — wins on overlap: syntaurd owns the PTY/process, so its exit
 * knowledge is ground truth. Daemon terminal states force isLive=false over
 * pid-liveness; working/blocked force true. `state` here is never null
 * (SessionState), so isLive is unconditional. `agentShortId`/`waitingFor` from
 * the claude-view join are left intact — `syntaurdShortId` is its own field,
 * reserved for `syntaur attach`.
 */
function applySyntaurdJoin(
  rows: AgentSessionWithLiveness[],
  entries: SyntaurdFeedEntry[],
): AgentSessionWithLiveness[] {
  if (entries.length === 0) return rows;
  const byId = new Map(entries.map((e) => [e.sessionId, e]));
  return rows.map((s) => {
    const e = byId.get(s.sessionId);
    if (!e) return s;
    return {
      ...s,
      state: e.state,
      syntaurdShortId: e.short,
      activity: stateToActivity(e.state) ?? s.activity,
      isLive: LIVE_STATES.has(e.state),
      launcher: 'syntaurd' as const,
    };
  });
}

export async function loadSessions(opts: LoadSessionsOptions): Promise<AgentSessionWithLiveness[]> {
  const sessions = await listAllSessions(opts.projectsDir);
  const enriched = enrichSessions(sessions, opts.agents, opts.livenessDeps);

  const source = opts.agentViewDetailSource ?? productionAgentViewDetailSource;
  const detail = await resolveDetailEntries(source);
  const withNative = applyNativeJoin(enriched, detail);

  const syntaurdSource = opts.syntaurdSessionSource ?? productionSyntaurdSessionSource;
  const daemonEntries = await resolveSyntaurdEntries(syntaurdSource);
  return applySyntaurdJoin(withNative, daemonEntries);
}

export function liveOnly(sessions: AgentSessionWithLiveness[]): AgentSessionWithLiveness[] {
  return sessions.filter((s) => s.isLive);
}
