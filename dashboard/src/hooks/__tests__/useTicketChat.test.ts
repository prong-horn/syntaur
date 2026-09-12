import { describe, expect, it } from 'vitest';
import {
  applyFrame,
  applyPatch,
  authorOf,
  chipAgents,
  emptyChatState,
  mergePage,
  openTurn,
  sortItems,
  withdrawableMessageId,
  workingByAgent,
  type ChatState,
} from '../../lib/chat-api';
import type {
  ChatAgentSummary,
  ChatItem,
  ChatSessionSummary,
  ItemPatch,
} from '../../lib/chat-types';

/**
 * Task 8 — the pure reducer behind `useTicketChat`. It lives in
 * `lib/chat-api.ts` precisely so it runs under the node-env dashboard vitest
 * config (no jsdom, no React), the same split `wsManager.ts` uses.
 *
 * Run with: npx vitest run -c vitest.dashboard.config.ts
 */

const ASSIGNMENT = 'ticket-1';

function item(overrides: Partial<ChatItem> & { itemId: string }): ChatItem {
  return {
    ticketId: ASSIGNMENT,
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
    ticketId: ASSIGNMENT,
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
    commands: [],
    commandsSource: null,
  };

  it('applies a chat-item patch for this ticket', () => {
    const state = applyFrame(emptyChatState(), ASSIGNMENT, 'chat-item', {
      ticketId: ASSIGNMENT,
      patch: upsert(item({ itemId: 't1:0' })),
    });
    expect(state.items.size).toBe(1);
  });

  it('ignores frames for another ticket — /ws has no topics', () => {
    const before = emptyChatState();
    const after = applyFrame(before, ASSIGNMENT, 'chat-item', {
      ticketId: 'someone-else',
      patch: upsert(item({ itemId: 't1:0', ticketId: 'someone-else' })),
    });
    expect(after).toBe(before);
  });

  it('upserts a chat-session frame by agent id', () => {
    const state = applyFrame(emptyChatState(), ASSIGNMENT, 'chat-session', {
      ticketId: ASSIGNMENT,
      agentId: 'claude',
      session,
    });
    expect(state.sessions.get('claude')).toEqual(session);
  });

  it('keeps one session per agent — a second agent does not evict the first', () => {
    let state = applyFrame(emptyChatState(), ASSIGNMENT, 'chat-session', {
      ticketId: ASSIGNMENT,
      agentId: 'planner',
      session: { ...session, agentId: 'planner' },
    });
    state = applyFrame(state, ASSIGNMENT, 'chat-session', {
      ticketId: ASSIGNMENT,
      agentId: 'implementer',
      session: { ...session, agentId: 'implementer', state: 'idle' },
    });
    expect([...state.sessions.keys()].sort()).toEqual(['implementer', 'planner']);
    expect(state.sessions.get('planner')?.state).toBe('running');
    expect(state.sessions.get('implementer')?.state).toBe('idle');
  });

  it('replaces the participant set and the roster on a chat-participants frame', () => {
    const agents: ChatAgentSummary[] = [
      {
        id: 'planner',
        name: 'Planner',
        color: 'violet',
        harness: 'claude',
        model: null,
        mode: null,
        effort: null,
        respondsTo: 'mentions',
        description: null,
        avatar: 'P',
        default: true,
        source: '/agents/planner.md',
        builtin: false,
        overridesBuiltin: false,
        missing: null,
      },
    ];
    const state = applyFrame(emptyChatState(), ASSIGNMENT, 'chat-participants', {
      ticketId: ASSIGNMENT,
      participants: { agents: ['planner'], defaultAgent: 'planner', hopBudget: 3 },
      agents,
    });
    expect(state.participants).toEqual({ agents: ['planner'], defaultAgent: 'planner', hopBudget: 3 });
    expect(state.agents).toEqual(agents);
  });

  it('tolerates a malformed or absent payload', () => {
    const before = emptyChatState();
    expect(applyFrame(before, ASSIGNMENT, 'chat-item', undefined)).toBe(before);
    expect(applyFrame(before, ASSIGNMENT, 'chat-item', 'nonsense')).toBe(before);
    expect(applyFrame(before, ASSIGNMENT, 'chat-item', { ticketId: ASSIGNMENT })).toBe(before);
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
    expect(workingByAgent([running], now).get('claude')).toEqual({
      since: '2026-09-02T12:00:00.000Z',
      elapsedMs: 25_400,
    });
  });

  it('is per agent — two agents can be working at once', () => {
    const other = item({
      itemId: 't2:0',
      agentId: 'implementer',
      turnId: 't2',
      type: 'turn.status',
      state: 'running',
      startedAt: '2026-09-02T12:00:10.000Z',
    } as Partial<ChatItem> & { itemId: string });
    const working = workingByAgent([running, other], Date.parse('2026-09-02T12:00:20.000Z'));
    expect([...working.keys()].sort()).toEqual(['claude', 'implementer']);
    expect(working.get('claude')?.elapsedMs).toBe(20_000);
    expect(working.get('implementer')?.elapsedMs).toBe(10_000);
  });

  it('is empty once the turn ends', () => {
    expect(openTurn([ended])).toBeNull();
    expect(workingByAgent([ended], Date.now()).size).toBe(0);
    expect(workingByAgent([], Date.now()).size).toBe(0);
  });

  it('never reports negative elapsed time', () => {
    expect(
      workingByAgent([running], Date.parse('2026-09-02T11:59:00.000Z')).get('claude')?.elapsedMs,
    ).toBe(0);
  });
});

describe('authorOf', () => {
  const agents: ChatAgentSummary[] = [
    {
      id: 'planner',
      name: 'Planner',
      color: 'violet',
      harness: 'claude',
      model: null,
      mode: null,
      effort: null,
      respondsTo: 'mentions',
      description: null,
      avatar: '🗺️',
      default: true,
      source: null,
      builtin: false,
      overridesBuiltin: false,
      missing: null,
    },
  ];

  it('names the human “You”', () => {
    expect(authorOf({ agentId: 'human' }, agents)).toMatchObject({ name: 'You' });
  });

  it('names Syntaur’s own routing notices', () => {
    expect(authorOf({ agentId: 'system' }, agents)).toMatchObject({ name: 'Syntaur' });
  });

  it('resolves an attached agent to its name, colour and avatar', () => {
    expect(authorOf({ agentId: 'planner' }, agents)).toEqual({
      id: 'planner',
      name: 'Planner',
      color: 'violet',
      avatar: '🗺️',
    });
  });

  it('still renders a row whose definition has since been deleted', () => {
    expect(authorOf({ agentId: 'ghost' }, agents)).toEqual({
      id: 'ghost',
      name: 'ghost',
      color: 'slate',
      avatar: 'G',
    });
  });
});

describe('chipAgents', () => {
  const working = (ids: string[]) =>
    new Map(ids.map((id) => [id, { since: '2026-09-02T12:00:00.000Z', elapsedMs: 1 }]));

  it('is the attached set when nobody unattached is running', () => {
    expect(chipAgents(['planner', 'implementer'], working([]))).toEqual(['planner', 'implementer']);
  });

  it('keeps a chip for a detached agent whose turn is still open', () => {
    // Between the detach and the cancel resolving, the agent is still spending;
    // dropping its chip would drop its interrupt button too.
    expect(chipAgents(['planner'], working(['implementer']))).toEqual(['planner', 'implementer']);
  });

  it('does not duplicate an attached agent that is working', () => {
    expect(chipAgents(['planner'], working(['planner']))).toEqual(['planner']);
  });
});

describe('withdrawableMessageId', () => {
  it('gives the messageId for a human trigger and nothing for a hop', () => {
    expect(withdrawableMessageId({ trigger: { kind: 'human', messageId: 'm1' } })).toBe('m1');
    expect(withdrawableMessageId({ trigger: { kind: 'handoff' } })).toBeNull();
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
