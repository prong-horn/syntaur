/**
 * Liveness for a dispatched scheduled job (Decision 3, phase 4).
 *
 * A scheduled attempt is a chat message, so "is it still running?" is "is any
 * turn this message triggered still open?" — not a pid probe. The old
 * `isScheduledSessionLive` resolved a session id, then a registry row, then a
 * wrapper pid; none of those exist any more.
 *
 * The conservative default survives the rewrite unchanged and matters just as
 * much: an UNKNOWN answer (a chat that has never seen the id, a dashboard that
 * cannot be reached) reads as OPEN. Reaping a live job because a signal was
 * missing is the failure mode this ordering exists to prevent; a stuck job is
 * visible and fixable, a wrongly-completed one is silent.
 */

import type { ChatDispatcher } from './dispatch.js';

export type IsMessageTurnOpen = (assignmentId: string, messageId: string) => Promise<boolean>;

/** Build the tick's `isMessageTurnOpen` dependency over a dispatcher. */
export function messageTurnOpenVia(dispatcher: ChatDispatcher): IsMessageTurnOpen {
  return async (assignmentId, messageId) => {
    let state;
    try {
      state = await dispatcher.messageState(assignmentId, messageId);
    } catch {
      return true; // unreachable → unknown → open
    }
    if (!state) return true; // never seen → unknown → open
    return state.state !== 'ended';
  };
}
