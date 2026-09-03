import { describe, it, expect } from 'vitest';
import { messageTurnProbeVia } from '../schedules/liveness.js';
import type { ChatDispatcher } from '../schedules/dispatch.js';
import type { MessageTurnState } from '../chat/message-state.js';

/**
 * Phase 4 (Decision 3): a scheduled attempt's liveness is its dispatched
 * message's turn, not a pid. The probe is THREE-valued so `reapStale` can tell
 * "still working" from "cannot tell" — the second is what the state-unknown
 * ceiling bounds (code review finding 5).
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

describe('messageTurnProbeVia', () => {
  it('is open while the message is queued', async () => {
    const probe = messageTurnProbeVia(dispatcherReturning({ state: 'queued' }));
    expect(await probe('a-1', 'msg-1')).toBe('open');
  });

  it('is open while a turn it triggered is running', async () => {
    const probe = messageTurnProbeVia(dispatcherReturning({ state: 'running' }));
    expect(await probe('a-1', 'msg-1')).toBe('open');
  });

  it('is ended once every turn has ended', async () => {
    const probe = messageTurnProbeVia(
      dispatcherReturning({ state: 'ended', stopReason: 'end_turn' }),
    );
    expect(await probe('a-1', 'msg-1')).toBe('ended');
  });

  it('is UNKNOWN — not ended — when the chat has never seen the message', async () => {
    const probe = messageTurnProbeVia(dispatcherReturning(null));
    expect(await probe('a-1', 'msg-gone')).toBe('unknown');
  });

  it('is UNKNOWN — not ended — when the chat cannot be reached at all', async () => {
    const probe = messageTurnProbeVia(
      dispatcherReturning(() => {
        throw new Error('ECONNREFUSED');
      }),
    );
    expect(await probe('a-1', 'msg-1')).toBe('unknown');
  });
});
