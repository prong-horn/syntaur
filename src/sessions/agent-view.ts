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
import type { ActivityState } from '../dashboard/types.js';

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
