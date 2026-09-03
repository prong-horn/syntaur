/**
 * Liveness for a dispatched scheduled job (Decision 3, phase 4).
 *
 * A scheduled attempt is a chat message, so "is it still running?" is "is any
 * turn this message triggered still open?" — not a pid probe. The old
 * `isScheduledSessionLive` resolved a session id, then a registry row, then a
 * wrapper pid; none of those exist any more.
 *
 * The answer is deliberately THREE-valued. `open` and `ended` are facts;
 * `unknown` is the chat being unreachable, reindexed, or never having seen the
 * id. Collapsing `unknown` into `open` — which this did until the phase-4 code
 * review — is the right default, because reaping a live job on a missing signal
 * is the silent failure this ordering exists to prevent. But held forever it
 * strands a job in `running` with no way out, so `reapStale` bounds it with a
 * ceiling (see `stateUnknownCeilingMs`). Keeping the three values distinct here
 * is what lets it tell "still working" from "cannot tell".
 */

import type { ChatDispatcher } from './dispatch.js';

export type MessageTurnLiveness = 'open' | 'ended' | 'unknown';

export type ProbeMessageTurn = (
  assignmentId: string,
  messageId: string,
) => Promise<MessageTurnLiveness>;

/** Build the tick's `probeMessageTurn` dependency over a dispatcher. */
export function messageTurnProbeVia(dispatcher: ChatDispatcher): ProbeMessageTurn {
  return async (assignmentId, messageId) => {
    let state;
    try {
      state = await dispatcher.messageState(assignmentId, messageId);
    } catch {
      return 'unknown'; // the dashboard could not be reached
    }
    if (!state) return 'unknown'; // the chat has never seen this id
    return state.state === 'ended' ? 'ended' : 'open';
  };
}
