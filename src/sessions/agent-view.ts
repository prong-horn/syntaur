/**
 * Agent-View liveness source — an injectable seam (mirrors the engagement
 * token-source seam) that surfaces the set of CURRENTLY LIVE Claude sessions and
 * their `activity`, sourced from `claude agents --json` (the Claude Agent View)
 * and joined to Syntaur sessions by `session_id`. See decision-record.md
 * Decision 5 + spike `spike/agent-view-sync` (commit `1e27330`).
 *
 * Contract (Decision 5):
 *   - The probe is **best-effort**: a missing/unparseable `claude agents --json`
 *     resolves to an EMPTY map. The scanner then falls back to pid/transcript
 *     liveness with no regression.
 *   - Agent-View presence is an ADDITIONAL keep-alive (and may revive a wrongly
 *     `stopped` row). **Absence is NOT death evidence** — death still requires
 *     the pid/transcript test. The scanner enforces that; this module only
 *     reports who is live.
 *   - The source is async (spawns a child process) so the scanner awaits it
 *     BEFORE its synchronous sweep transaction (the #1 async/sync boundary).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ActivityState, NativeAgentState } from '../dashboard/types.js';

const execFileAsync = promisify(execFile);

/** Resolve the live sessions keyed by `session_id` → their Agent-View activity. */
export type AgentViewSource = () => Promise<Map<string, ActivityState>>;

/** Coerce a raw Agent-View status string to a canonical `ActivityState`, else null. */
function toActivityState(raw: unknown): ActivityState | null {
  switch (raw) {
    case 'working':
    case 'idle':
    case 'awaiting-input':
      return raw;
    default:
      return null;
  }
}

interface RawAgentEntry {
  session_id?: unknown;
  sessionId?: unknown;
  activity?: unknown;
  status?: unknown;
}

/**
 * Parse the `claude agents --json` payload into the live-session map. Accepts
 * either a bare array or an `{ agents: [...] }` envelope, and either
 * `session_id` or `sessionId`. Only entries with a usable id are kept; an entry
 * whose activity is unrecognized still counts as LIVE (mapped to `idle`) so its
 * mere presence keeps the session alive. PURE — unit-tested directly.
 */
export function parseAgentView(json: string): Map<string, ActivityState> {
  const live = new Map<string, ActivityState>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return live;
  }
  const entries: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { agents?: unknown }).agents)
      ? ((parsed as { agents: unknown[] }).agents)
      : [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as RawAgentEntry;
    const id = typeof e.session_id === 'string' ? e.session_id
      : typeof e.sessionId === 'string' ? e.sessionId
        : null;
    if (!id) continue;
    live.set(id, toActivityState(e.activity ?? e.status) ?? 'idle');
  }
  return live;
}

/**
 * Production source: spawn `claude agents --json` and parse it. Best-effort —
 * any spawn/parse failure (binary absent, non-zero exit, malformed JSON) yields
 * an empty map. A short timeout keeps the scanner off a hung subprocess.
 */
export const productionAgentViewSource: AgentViewSource = async () => {
  try {
    const { stdout } = await execFileAsync('claude', ['agents', '--json'], {
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return parseAgentView(stdout);
  } catch {
    return new Map();
  }
};

let override: AgentViewSource | null = null;

/** Inject an Agent-View source (tests). Pass `null` to restore production. */
export function setAgentViewSource(src: AgentViewSource | null): void {
  override = src;
}

/** The active Agent-View source — the injected override, else production. */
export function getAgentViewSource(): AgentViewSource {
  return override ?? productionAgentViewSource;
}

// --- Detail entries (v2 monitor join: native state/waitingFor/short id) ---

export interface AgentViewDetailEntry {
  sessionId: string;
  /** Short id `claude attach <id>` accepts — falls back to a session-id prefix if the payload omits it. */
  id: string;
  name: string | null;
  state: NativeAgentState | null;
  waitingFor: string | null;
}

function toNativeState(raw: unknown): NativeAgentState | null {
  switch (raw) {
    case 'working':
    case 'blocked':
    case 'done':
    case 'failed':
    case 'stopped':
      return raw;
    default:
      return null;
  }
}

interface RawDetailEntry {
  session_id?: unknown;
  sessionId?: unknown;
  id?: unknown;
  agentId?: unknown;
  name?: unknown;
  agentName?: unknown;
  state?: unknown;
  status?: unknown;
  waitingFor?: unknown;
  waiting_for?: unknown;
}

/**
 * Parse the `claude agents --json` payload into detail entries (state,
 * waitingFor, short id, name) for the v2 monitor join. Distinct failure
 * contract from `parseAgentView` above (Task 5 depends on this distinction):
 * returns `null` when the payload is malformed JSON or not a recognizable
 * agents envelope at all (probe failure — caller should hold last-known
 * state), vs `[]` for a validly-shaped but genuinely empty list (all agents
 * really did end — caller should clear immediately). PURE — unit-tested
 * directly.
 */
export function parseAgentViewDetail(json: string): AgentViewDetailEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const entries: unknown[] | null = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { agents?: unknown })?.agents)
      ? ((parsed as { agents: unknown[] }).agents)
      : null;
  if (entries === null) return null;

  const out: AgentViewDetailEntry[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as RawDetailEntry;
    const sessionId = typeof e.session_id === 'string' ? e.session_id
      : typeof e.sessionId === 'string' ? e.sessionId
        : null;
    if (!sessionId) continue;
    const id = typeof e.id === 'string' ? e.id
      : typeof e.agentId === 'string' ? e.agentId
        : sessionId.slice(0, 8);
    const name = typeof e.name === 'string' ? e.name
      : typeof e.agentName === 'string' ? e.agentName
        : null;
    const waitingFor = typeof e.waitingFor === 'string' ? e.waitingFor
      : typeof e.waiting_for === 'string' ? e.waiting_for
        : null;
    out.push({ sessionId, id, name, state: toNativeState(e.state ?? e.status), waitingFor });
  }
  return out;
}

/** Resolve the raw `claude agents --json` stdout, or `null` on any spawn/exec failure. */
async function execAgentsJson(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('claude', ['agents', '--json'], {
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

/** Resolve the live detail entries, or `null` on probe failure (see `parseAgentViewDetail`). */
export type AgentViewDetailSource = () => Promise<AgentViewDetailEntry[] | null>;

/**
 * Production detail source: same `claude agents --json` invocation as
 * `productionAgentViewSource` above, kept as its own exec call (the two
 * sources serve independent consumers — the dashboard scanner vs. the
 * cockpit feed — so there's no single call site to share) but returning the
 * distinct null-vs-[] failure contract `parseAgentViewDetail` defines.
 */
export const productionAgentViewDetailSource: AgentViewDetailSource = async () => {
  const stdout = await execAgentsJson();
  if (stdout === null) return null;
  return parseAgentViewDetail(stdout);
};
