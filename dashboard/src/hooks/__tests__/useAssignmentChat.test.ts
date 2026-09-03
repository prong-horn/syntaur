import { describe, expect, it } from 'vitest';
import {
  applyFrame,
  applyPatch,
  emptyChatState,
  mergePage,
  openTurn,
  sortItems,
  workingFor,
  type ChatState,
} from '../../lib/chat-api';
import type { ChatItem, ChatSessionSummary, ItemPatch } from '../../lib/chat-types';

/**
 * Task 8 — the pure reducer behind `useAssignmentChat`. It lives in
 * `lib/chat-api.ts` precisely so it runs under the node-env dashboard vitest
 * config (no jsdom, no React), the same split `wsManager.ts` uses.
 *
 * Run with: npx vitest run -c vitest.dashboard.config.ts
 */

const ASSIGNMENT = 'assignment-1';

function item(overrides: Partial<ChatItem> & { itemId: string }): ChatItem {
  return {
    assignmentId: ASSIGNMENT,
    turnId: 't1',
    agentId: 'claude',
    type: 'system',
    ts: '2026-09-02T12:00:00.000Z',
    seqFirst: 0,
    seqLast: 0,
    sealed: true,
    level: 'info',
    text: 'hello',
    ...overrides,
  } as ChatItem;
}

const upsert = (i: ChatItem): ItemPatch => ({ op: 'upsert', item: i });

function stateWith(...items: ChatItem[]): ChatState {
  let state = emptyChatState();
  for (const i of items) state = applyPatch(state, upsert(i));
  return state;
}

describe('sortItems', () => {
  it('orders by seqFirst, breaking ties on itemId', () => {
    const state = stateWith(
      item({ itemId: 't1:2', seqFirst: 5 }),
      item({ itemId: 't1:0', seqFirst: 1 }),
      item({ itemId: 't1:1', seqFirst: 5 }),
    );
    expect(sortItems(state.items.values()).map((i) => i.itemId)).toEqual(['t1:0', 't1:1', 't1:2']);
  });
});

describe('applyPatch', () => {
  it('upsert replaces the item wholesale', () => {
    let state = stateWith(item({ itemId: 't1:0', text: 'v1' }));
    state = applyPatch(state, upsert(item({ itemId: 't1:0', text: 'v2', seqLast: 9 })));
    expect(state.items.size).toBe(1);
    expect((state.items.get('t1:0') as { text: string }).text).toBe('v2');
    expect(state.items.get('t1:0')?.seqLast).toBe(9);
  });

  it('retract deletes the item — the fold rule turned it into a card lead', () => {
    let state = stateWith(item({ itemId: 't1:0' }), item({ itemId: 't1:1', seqFirst: 1 }));
    state = applyPatch(state, { op: 'retract', itemId: 't1:0' });
    expect([...state.items.keys()]).toEqual(['t1:1']);
  });

  it('retracting an unknown id returns the same state object', () => {
    const state = stateWith(item({ itemId: 't1:0' }));
    expect(applyPatch(state, { op: 'retract', itemId: 'nope' })).toBe(state);
  });

  it('never mutates the previous state', () => {
    const before = stateWith(item({ itemId: 't1:0' }));
    const after = applyPatch(before, upsert(item({ itemId: 't1:1', seqFirst: 1 })));
    expect(before.items.size).toBe(1);
    expect(after.items.size).toBe(2);
  });
});

describe('applyFrame', () => {
  const session: ChatSessionSummary = {
    assignmentId: ASSIGNMENT,
    agentId: 'claude',
    harness: 'claude',
    acpSessionId: 'acp-1',
    adapterVersion: null,
    state: 'running',
    model: null,
    mode: null,
    effort: null,
    lastTurnAt: null,
    cumulative: null,
    queued: [],
    lastDeliveredSeq: 0,
  };

  it('applies a chat-item patch for this assignment', () => {
    const state = applyFrame(emptyChatState(), ASSIGNMENT, 'chat-item', {
      assignmentId: ASSIGNMENT,
      patch: upsert(item({ itemId: 't1:0' })),
    });
    expect(state.items.size).toBe(1);
  });

  it('ignores frames for another assignment — /ws has no topics', () => {
    const before = emptyChatState();
    const after = applyFrame(before, ASSIGNMENT, 'chat-item', {
      assignmentId: 'someone-else',
      patch: upsert(item({ itemId: 't1:0', assignmentId: 'someone-else' })),
    });
    expect(after).toBe(before);
  });

  it('replaces the session on a chat-session frame', () => {
    const state = applyFrame(emptyChatState(), ASSIGNMENT, 'chat-session', {
      assignmentId: ASSIGNMENT,
      agentId: 'claude',
      session,
    });
    expect(state.session).toEqual(session);
  });

  it('tolerates a malformed or absent payload', () => {
    const before = emptyChatState();
    expect(applyFrame(before, ASSIGNMENT, 'chat-item', undefined)).toBe(before);
    expect(applyFrame(before, ASSIGNMENT, 'chat-item', 'nonsense')).toBe(before);
    expect(applyFrame(before, ASSIGNMENT, 'chat-item', { assignmentId: ASSIGNMENT })).toBe(before);
  });
});

describe('mergePage', () => {
  it('merges without disturbing streamed items and tracks the oldest seq', () => {
    const streamed = stateWith(item({ itemId: 't2:0', seqFirst: 50 }));
    const merged = mergePage(
      streamed,
      { items: [item({ itemId: 't1:0', seqFirst: 10 }), item({ itemId: 't1:1', seqFirst: 11 })], oldestSeq: 10 },
      200,
    );
    expect(sortItems(merged.items.values()).map((i) => i.itemId)).toEqual(['t1:0', 't1:1', 't2:0']);
    expect(merged.oldestSeq).toBe(10);
    // A short page means there is nothing older.
    expect(merged.hasMore).toBe(false);
  });

  it('keeps paging while a full page comes back', () => {
    const page = { items: [item({ itemId: 'a', seqFirst: 5 }), item({ itemId: 'b', seqFirst: 6 })], oldestSeq: 5 };
    expect(mergePage(emptyChatState(), page, 2).hasMore).toBe(true);
  });

  it('keeps the smaller oldestSeq when an older page arrives', () => {
    let state = mergePage(emptyChatState(), { items: [item({ itemId: 'b', seqFirst: 20 })], oldestSeq: 20 }, 1);
    state = mergePage(state, { items: [item({ itemId: 'a', seqFirst: 3 })], oldestSeq: 3 }, 1);
    expect(state.oldestSeq).toBe(3);
  });

  it('leaves oldestSeq alone for an empty page', () => {
    const state = mergePage(
      { ...emptyChatState(), oldestSeq: 7 },
      { items: [], oldestSeq: null },
      200,
    );
    expect(state.oldestSeq).toBe(7);
    expect(state.hasMore).toBe(false);
  });
});

describe('the working indicator', () => {
  const running = item({
    itemId: 't1:0',
    type: 'turn.status',
    state: 'running',
    startedAt: '2026-09-02T12:00:00.000Z',
  } as Partial<ChatItem> & { itemId: string });

  const ended = item({
    itemId: 't1:0',
    type: 'turn.status',
    state: 'ended',
    startedAt: '2026-09-02T12:00:00.000Z',
  } as Partial<ChatItem> & { itemId: string });

  it('is driven by Syntaur’s own clock, because claude sends no thinking signal', () => {
    const now = Date.parse('2026-09-02T12:00:25.400Z');
    expect(workingFor([running], now)).toEqual({
      since: '2026-09-02T12:00:00.000Z',
      elapsedMs: 25_400,
    });
  });

  it('is null once the turn ends', () => {
    expect(openTurn([ended])).toBeNull();
    expect(workingFor([ended], Date.now())).toBeNull();
    expect(workingFor([], Date.now())).toBeNull();
  });

  it('never reports negative elapsed time', () => {
    expect(workingFor([running], Date.parse('2026-09-02T11:59:00.000Z'))?.elapsedMs).toBe(0);
  });
});

describe('user messages', () => {
  it('a withdrawn message stays in the list so it can render faded', () => {
    let state = stateWith(
      item({ itemId: 't1:0', type: 'user.message', messageId: 'm1', text: 'hi', state: 'queued' } as never),
    );
    state = applyPatch(
      state,
      upsert(item({ itemId: 't1:0', type: 'user.message', messageId: 'm1', text: 'hi', state: 'withdrawn' } as never)),
    );
    expect(state.items.size).toBe(1);
    expect((state.items.get('t1:0') as { state: string }).state).toBe('withdrawn');
  });
});
