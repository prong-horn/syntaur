import type { LogEntry } from '../ticket-templates/log-reader.js';
import { parseChatQuestionMarker } from '../chat/questions.js';
import type { ChatQuestionKind } from '../chat/types.js';

export function byQuestionTimestamp(ts: string): (e: LogEntry) => boolean {
  return (e) => e.type === 'question' && e.timestamp === ts;
}

export function byAgentAndKind(
  agentId: string,
  kinds: ChatQuestionKind[],
): (e: LogEntry) => boolean {
  const kindSet = new Set(kinds);
  return (e) => {
    if (e.author !== agentId || e.type !== 'question') return false;
    const { ref } = parseChatQuestionMarker(e.body);
    return ref !== null && kindSet.has(ref.kind);
  };
}

export function byKindAndItemIds(
  kind: ChatQuestionKind,
  itemIds: string[],
): (e: LogEntry) => boolean {
  const idSet = new Set(itemIds);
  return (e) => {
    if (e.type !== 'question') return false;
    const { ref } = parseChatQuestionMarker(e.body);
    return ref !== null && ref.kind === kind && idSet.has(ref.itemId);
  };
}
