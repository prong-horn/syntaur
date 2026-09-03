/**
 * Where one dispatched chat message stands — the liveness signal a scheduled
 * job's attempt runs on (Decision 3, phase 4).
 *
 * A scheduled dispatch is tracked by its `messageId` alone: no session id, no
 * pid. The message is `queued` until a target's turn starts, `running` while any
 * turn triggered by it is open, and `ended` once every one of them has ended.
 * Derived from the `chat_items` index, which is rebuildable from
 * `chat/events.jsonl` — so a dashboard restart mid-turn still resolves (the
 * crash-repair pass seals the orphaned turn as `error`, which reads as `ended`).
 */

import { getUserMessageItem, listTurnsForMessage } from '../db/chat-db.js';
import type { TurnStatusItem, UserMessageItem } from './types.js';

export type MessageTurnPhase = 'queued' | 'running' | 'ended';

export interface MessageTurnState {
  state: MessageTurnPhase;
  /** The last stop reason among the message's turns, when they have all ended. */
  stopReason?: string;
}

/**
 * Resolve a message's phase, or `null` when the chat has no such message —
 * which the caller must treat as "unknown", never as "finished": terminalizing
 * a job on a missing signal is exactly the false-negative the old pid-based
 * liveness was written to avoid.
 */
export function messageTurnState(
  assignmentId: string,
  messageId: string,
): MessageTurnState | null {
  const item = getUserMessageItem(assignmentId, messageId) as UserMessageItem | null;
  if (!item) return null;

  if (item.state === 'withdrawn') return { state: 'ended', stopReason: 'withdrawn' };

  const turns = listTurnsForMessage(assignmentId, messageId) as TurnStatusItem[];
  if (turns.length === 0) {
    // No turn has started yet. A message routed to nobody has no turn coming,
    // so it is finished rather than waiting forever.
    const targets = item.targets ?? [];
    if (targets.length === 0) return { state: 'ended', stopReason: 'unrouted' };
    return { state: 'queued' };
  }
  if (turns.some((t) => t.state === 'running')) return { state: 'running' };

  // Every turn that started has ended — but a fan-out may still owe a target.
  const started = new Set(item.deliveredTo ?? []);
  const targets = item.targets ?? [];
  if (targets.some((id) => !started.has(id))) return { state: 'queued' };

  const last = turns[turns.length - 1];
  return {
    state: 'ended',
    ...(last.stopReason ? { stopReason: last.stopReason } : {}),
  };
}
