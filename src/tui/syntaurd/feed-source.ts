import { queryDaemon } from '../../daemon/client.js';
import type { ListReply, SessionState } from '../../daemon/types.js';

/** One joinable daemon session, projected from the wire `Session` record. */
export interface SyntaurdFeedEntry {
  /** The session-db join key (dispatch-supplied; sessions without one — e.g. `syntaur bg` — are filtered out). */
  sessionId: string;
  /** Short id `syntaur attach <short>` accepts. */
  short: string;
  state: SessionState;
  name: string | null;
  agent: string;
}

/**
 * Same failure contract as AgentViewDetailSource:
 * `null` = daemon unreachable / probe failure (caller holds last-known
 * state for ≤1 poll), `[]` = live daemon with no joinable sessions (caller
 * clears the overlay immediately — real information, not a failure).
 */
export type SyntaurdSessionSource = () => Promise<SyntaurdFeedEntry[] | null>;

const LIST_TIMEOUT_MS = 1000;

type QueryFn = typeof queryDaemon;

/**
 * Production source: a NON-SPAWNING `{op:'list'}` poll. Never uses
 * ensureDaemon/daemonRequest — a feed tick must not resurrect a
 * deliberately stopped daemon. Never throws. Factory shape — `query`
 * injectable — so tests exercise the projection and failure contract
 * directly, without module mocking.
 */
export const makeSyntaurdSessionSource = (query: QueryFn = queryDaemon): SyntaurdSessionSource => async () => {
  let reply;
  try {
    reply = await query({ op: 'list' }, { timeoutMs: LIST_TIMEOUT_MS });
  } catch {
    return null; // hung/garbled daemon — a probe failure, not "validly empty"
  }
  if (reply === null || reply.ok !== true) return null;
  const sessions = (reply as ListReply).sessions ?? [];
  const out: SyntaurdFeedEntry[] = [];
  for (const s of sessions) {
    if (typeof s.sessionId !== 'string' || s.sessionId === '') continue;
    out.push({ sessionId: s.sessionId, short: s.short, state: s.state, name: s.name ?? null, agent: s.agent });
  }
  return out;
};

export const productionSyntaurdSessionSource: SyntaurdSessionSource = makeSyntaurdSessionSource();
