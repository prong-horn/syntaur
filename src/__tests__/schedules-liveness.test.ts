import { describe, it, expect } from 'vitest';
import { messageTurnOpenVia } from '../schedules/liveness.js';
import type { ChatDispatcher } from '../schedules/dispatch.js';
import type { MessageTurnState } from '../chat/message-state.js';

/**
 * Phase 4 (Decision 3): a scheduled attempt's liveness is its dispatched
 * message's turn, not a pid. The property that matters most survives the
 * rewrite: an UNKNOWN answer reads as OPEN, so a missing signal never
 * terminalizes a live job.
 */

function dispatcherReturning(
  result: MessageTurnState | null | (() => never),
): ChatDispatcher {
  return {
    attachedAgents: async () => [],
    send: async () => 'msg',
    withdraw: async () => false,
    cancel: async () => false,
    messageState: async () => {
      if (typeof result === 'function') return result();
      return result;
    },
  };
}

describe('messageTurnOpenVia', () => {
  it('is open while the message is queued', async () => {
    const open = messageTurnOpenVia(dispatcherReturning({ state: 'queued' }));
    expect(await open('a-1', 'msg-1')).toBe(true);
  });

  it('is open while a turn it triggered is running', async () => {
    const open = messageTurnOpenVia(dispatcherReturning({ state: 'running' }));
    expect(await open('a-1', 'msg-1')).toBe(true);
  });

  it('is closed once every turn has ended', async () => {
    const open = messageTurnOpenVia(
      dispatcherReturning({ state: 'ended', stopReason: 'end_turn' }),
    );
    expect(await open('a-1', 'msg-1')).toBe(false);
  });

  it('is OPEN when the chat has never seen the message (unknown, not finished)', async () => {
    const open = messageTurnOpenVia(dispatcherReturning(null));
    expect(await open('a-1', 'msg-gone')).toBe(true);
  });

  it('is OPEN when the chat cannot be reached at all', async () => {
    const open = messageTurnOpenVia(
      dispatcherReturning(() => {
        throw new Error('ECONNREFUSED');
      }),
    );
    expect(await open('a-1', 'msg-1')).toBe(true);
  });
});
