import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import type { AgentConfig } from '../utils/config.js';
import type { AgentSession, AgentSessionWithLiveness } from './types.js';

const FIVE_MINUTES_MS = 5 * 60 * 1000;

/**
 * Injectable dependencies for the liveness probe so tests can supply
 * deterministic stubs instead of touching real processes / filesystem state.
 * Production callers pass nothing and get the real defaults.
 */
export interface LivenessDeps {
  /** Current wall-clock time. Defaults to Date.now. */
  now?: () => number;
  /** Returns the file mtime in ms, or null when the path is missing / unreadable. */
  statMtimeMs?: (path: string) => number | null;
  /** Returns true when a process with the given pid is currently running. */
  isPidAlive?: (pid: number) => boolean;
  /** Returns the stringified start time of the process, or null when unavailable. */
  pidStartedAt?: (pid: number) => string | null;
}

const DEFAULT_DEPS: Required<LivenessDeps> = {
  now: () => Date.now(),
  statMtimeMs: (path) => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return null;
    }
  },
  isPidAlive: (pid) => {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
      // Signal 0 doesn't deliver — it only probes existence + permission.
      // ESRCH: no such process; EPERM: process exists but we cannot signal.
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM') return true;
      return false;
    }
  },
  pidStartedAt: (pid) => {
    if (!Number.isFinite(pid) || pid <= 0) return null;
    try {
      const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const trimmed = out.trim();
      return trimmed === '' ? null : trimmed;
    } catch {
      return null;
    }
  },
};

function resolveDeps(deps?: LivenessDeps): Required<LivenessDeps> {
  return {
    now: deps?.now ?? DEFAULT_DEPS.now,
    statMtimeMs: deps?.statMtimeMs ?? DEFAULT_DEPS.statMtimeMs,
    isPidAlive: deps?.isPidAlive ?? DEFAULT_DEPS.isPidAlive,
    pidStartedAt: deps?.pidStartedAt ?? DEFAULT_DEPS.pidStartedAt,
  };
}

/**
 * Compute whether a session is "live" — i.e. there may still be a process
 * writing to its transcript. The UI disables Resume when isLive is true so
 * the user is forced to Fork instead, preventing two processes from
 * interleaving writes into the same transcript file.
 *
 * Tiered logic (matches Design Summary in assignment.md):
 *   1. status !== 'active' → false (manual override is definitive).
 *   2. pid present:
 *        2a. pid not alive → false (process is gone).
 *        2b. pid alive AND stored pid_started_at differs from current → false
 *            (PID was recycled by a different process; original is gone).
 *        2c. pid alive otherwise → true.
 *   3. transcriptPath present AND recently-touched (<5 min) → true.
 *   4. Default → true (safer: disable Resume, force Fork when no signal).
 */
export function computeIsLive(
  session: AgentSession,
  deps?: LivenessDeps,
): boolean {
  if (session.status !== 'active') return false;

  const d = resolveDeps(deps);

  const pid = session.pid;
  if (pid !== null && pid !== undefined) {
    if (!d.isPidAlive(pid)) return false;
    if (session.pidStartedAt) {
      const current = d.pidStartedAt(pid);
      if (current !== null && current !== session.pidStartedAt) {
        // PID exists but it's a different process now.
        return false;
      }
    }
    return true;
  }

  if (session.transcriptPath) {
    const mtime = d.statMtimeMs(session.transcriptPath);
    if (mtime !== null && d.now() - mtime < FIVE_MINUTES_MS) {
      return true;
    }
  }

  // No signal available — safer to assume live so Resume is gated off.
  return true;
}

/**
 * Enrich a session row with the server-derived flags the UI uses to render
 * Resume / Fork / Mark-stopped buttons.
 *
 * `resumeSupported` / `forkSupported` derive from the agent's `AgentConfig`
 * via the resolved agents list (typically `getAgents(config)`). When the
 * session's agent is missing from the list, both flags are false.
 */
export function enrichSession(
  session: AgentSession,
  agents: AgentConfig[],
  deps?: LivenessDeps,
): AgentSessionWithLiveness {
  const agent = agents.find((a) => a.id === session.agent);
  return {
    ...session,
    isLive: computeIsLive(session, deps),
    resumeSupported: agent?.resume != null,
    forkSupported: agent?.fork != null,
  };
}

export function enrichSessions(
  sessions: AgentSession[],
  agents: AgentConfig[],
  deps?: LivenessDeps,
): AgentSessionWithLiveness[] {
  return sessions.map((s) => enrichSession(s, agents, deps));
}
