// Dashboard-side sessionId → daemon <short> join (Phase D).
//
// The dashboard has no stored `short` — the daemon roster/JobState owns it. This
// resolves a session-db `sessionId` to the daemon short id AND classifies
// attach-eligibility, which is subtle: the daemon `list` op RETAINS dead hosts
// and emits them with a TERMINAL state, and `Session` carries no `live` flag, so
// liveness is derived from `state`, not from list-membership. `queryDaemon` is
// non-spawning (never resurrects a stopped daemon) and can either return null
// (no live daemon) or reject (connect/timeout) — both degrade to the on-disk
// jobs state, which still yields settled sessions after a daemon reap/restart.

import { queryDaemon } from '../daemon/client.js';
import { readAllJobStates as realReadAllJobStates, readJobState as realReadJobState } from '../daemon/jobs.js';
import type { ControlReply, JobState, ListReply, SessionState } from '../daemon/types.js';

const TERMINAL_STATES: ReadonlySet<SessionState> = new Set(['done', 'failed', 'stopped']);

/** A live, attach-eligible session (non-terminal daemon state). */
export interface LiveResolution {
  short: string;
  state: SessionState;
  needs: string | null;
  cols: number;
  rows: number;
  live: true;
}

/** A not-live session: terminal (settled, carries lastScreen via jobState) or a
 * non-terminal disk state with the daemon unavailable (retryable). The caller
 * distinguishes them via `jobState?.state`. */
export interface SettledResolution {
  short: string;
  state?: SessionState;
  live: false;
  jobState: JobState | null;
}

export type SessionResolution = LiveResolution | SettledResolution;

export interface DaemonJoinDeps {
  query?: (req: { op: 'list' }) => Promise<ControlReply | null>;
  readAllJobStates?: () => JobState[];
  readJobState?: (short: string) => JobState | null;
}

function isListReply(reply: ControlReply | null): reply is ListReply {
  return reply !== null && reply.ok === true && 'sessions' in reply && Array.isArray(reply.sessions);
}

/**
 * Resolve a session-db `sessionId` to `{ short, live, ... }`. Returns null only
 * when neither the live daemon nor on-disk jobs state knows the sessionId.
 */
export async function resolveShortForSession(
  sessionId: string,
  deps: DaemonJoinDeps = {},
): Promise<SessionResolution | null> {
  const query = deps.query ?? ((req) => queryDaemon(req));
  const readAllJobStates = deps.readAllJobStates ?? realReadAllJobStates;
  const readJobState = deps.readJobState ?? realReadJobState;

  if (!sessionId) return null;

  // (1) Live daemon list. null → no live daemon; a rejection (connect/timeout)
  // must degrade to disk, not throw out of the resolver.
  let listReply: ControlReply | null = null;
  try {
    listReply = await query({ op: 'list' });
  } catch {
    listReply = null;
  }

  if (isListReply(listReply)) {
    const match = listReply.sessions.find((s) => s.sessionId && s.sessionId === sessionId);
    if (match) {
      if (!TERMINAL_STATES.has(match.state)) {
        return {
          short: match.short,
          state: match.state,
          needs: match.needs ?? null,
          cols: match.cols,
          rows: match.rows,
          live: true,
        };
      }
      // Terminal daemon-list entry: settled, read its final screen from disk.
      return { short: match.short, state: match.state, live: false, jobState: readJobState(match.short) };
    }
  }

  // (2) Disk fallback — recovers settled sessions the daemon has reaped, and
  // covers the daemon-unavailable case.
  for (const js of readAllJobStates()) {
    if (js.sessionId && js.sessionId === sessionId) {
      return { short: js.short, state: js.state, live: false, jobState: js };
    }
  }

  return null;
}
