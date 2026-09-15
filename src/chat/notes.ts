import { randomUUID } from 'node:crypto';
import { openChatLog, rebuildChatIndex } from './store.js';
import { applyChatPatch } from '../db/chat-db.js';
import { ChatNormalizer } from './normalizer.js';
import { HUMAN_AGENT_ID } from './types.js';

const LOG_SESSION_KEY = 'syntaur-log';

/** Append a chat note when the ticket template has no log role. */
export async function appendChatNote(
  ticketDir: string,
  ticketId: string,
  author: string,
  text: string,
): Promise<{ timestamp: string }> {
  const log = await openChatLog(ticketDir);
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  if (author === 'human' || author === HUMAN_AGENT_ID) {
    const event = await log.append({
      ticketId,
      agentId: HUMAN_AGENT_ID,
      sessionKey: LOG_SESSION_KEY,
      turnId: null,
      kind: 'user.message',
      payload: { messageId: randomUUID(), text, state: 'sent' },
      ts,
    });
    const normalizer = new ChatNormalizer({
      ticketId,
      agentId: HUMAN_AGENT_ID,
      sessionKey: LOG_SESSION_KEY,
    });
    for (const patch of normalizer.ingest(event)) {
      applyChatPatch(LOG_SESSION_KEY, patch);
    }
  } else {
    const turnId = `log~${randomUUID()}`;
    const messageId = randomUUID();
    const normalizer = new ChatNormalizer({
      ticketId,
      agentId: author,
      sessionKey: LOG_SESSION_KEY,
    });
    const events = [
      await log.append({
        ticketId,
        agentId: author,
        sessionKey: LOG_SESSION_KEY,
        turnId,
        kind: 'turn.start',
        payload: {},
        ts,
      }),
      await log.append({
        ticketId,
        agentId: author,
        sessionKey: LOG_SESSION_KEY,
        turnId,
        kind: 'acp.update',
        payload: {
          sessionUpdate: 'agent_message_chunk',
          messageId,
          content: { type: 'text', text },
        },
        ts,
      }),
      await log.append({
        ticketId,
        agentId: author,
        sessionKey: LOG_SESSION_KEY,
        turnId,
        kind: 'turn.end',
        payload: {},
        ts,
      }),
    ];
    for (const event of events) {
      for (const patch of normalizer.ingest(event)) {
        applyChatPatch(LOG_SESSION_KEY, patch);
      }
    }
  }

  await rebuildChatIndex(ticketDir, ticketId);
  return { timestamp: ts };
}
