import { describe, expect, it } from 'vitest';
import {
  agentColorClasses,
  formatCost,
  formatDuration,
  formatLocations,
  formatTokens,
  orderPermissionOptions,
  permissionButtonTone,
  preferredAllowOption,
  pinnedPlan,
  summarizeTurn,
  summarizeWork,
  workInProgress,
  groupByTurn,
  activitySummary,
  isChatColumnItem,
  rankAgentTokens,
} from '../chat-format';
import { capRawIo, prettyJson, stripAnsi, toDiffLines, RAW_IO_CAP } from '../chat-blocks';
import type { AgentWorkItem, ChatItem } from '../chat-types';

/**
 * Task 9 — the pure half of the Chat tab. The components are gated by
 * `npm run build --prefix dashboard`; everything that can be a function is one,
 * and is tested here under the node-env dashboard config.
 */

describe('formatDuration', () => {
  it('scales from milliseconds to hours', () => {
    expect(formatDuration(820)).toBe('820ms');
    expect(formatDuration(3_000)).toBe('3s');
    expect(formatDuration(134_000)).toBe('2m 14s');
    expect(formatDuration(3_780_000)).toBe('1h 03m');
  });

  it('is empty for a missing or nonsensical duration', () => {
    expect(formatDuration(null)).toBe('');
    expect(formatDuration(undefined)).toBe('');
    expect(formatDuration(-5)).toBe('');
    expect(formatDuration(Number.NaN)).toBe('');
  });
});

describe('formatTokens', () => {
  it('abbreviates thousands and millions', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(41_200)).toBe('41.2k');
    expect(formatTokens(37_000)).toBe('37k');
    expect(formatTokens(1_250_000)).toBe('1.25M');
    expect(formatTokens(null)).toBe('');
  });
});

describe('formatCost', () => {
  it('keeps sub-cent turns visible instead of rounding them to zero', () => {
    expect(formatCost(0.19)).toBe('$0.19');
    expect(formatCost(0.0004)).toBe('$0.0004');
    expect(formatCost(0)).toBe('$0.00');
  });

  it('is empty when there is no cost — codex reports none until rates land', () => {
    expect(formatCost(null)).toBe('');
    expect(formatCost(undefined)).toBe('');
  });
});

describe('summarizeWork', () => {
  it('reads like the §5.3 example', () => {
    expect(
      summarizeWork({ reads: 9, edits: 3, runs: 2, failed: 0, durationMs: 134_000 }),
    ).toBe('Worked 2m 14s · read 9 · edited 3 · ran 2');
  });

  it('omits zero counts and calls out failures', () => {
    expect(summarizeWork({ reads: 1, edits: 0, runs: 0, failed: 0, durationMs: 2_000 })).toBe(
      'Worked 2s · read 1',
    );
    expect(summarizeWork({ reads: 0, edits: 0, runs: 3, failed: 1, durationMs: 1_000 })).toBe(
      'Worked 1s · ran 3 · 1 failed',
    );
  });
});

describe('workInProgress', () => {
  const card = (overrides: Partial<AgentWorkItem>): AgentWorkItem =>
    ({
      itemId: 't:0',
      ticketId: 'a',
      turnId: 't',
      agentId: 'claude',
      type: 'agent.work',
      ts: '2026-09-02T12:00:00.000Z',
      seqFirst: 0,
      seqLast: 0,
      sealed: true,
      tools: [],
      summary: { reads: 0, edits: 0, runs: 0, failed: 0, durationMs: 0 },
      ...overrides,
    }) as AgentWorkItem;

  it('is true while the card is unsealed or any row still runs', () => {
    expect(workInProgress(card({ sealed: false }))).toBe(true);
    expect(
      workInProgress(
        card({
          tools: [
            { toolCallId: 'a', kind: 'read', title: 'x', status: 'running', locations: [], content: [] },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      workInProgress(
        card({
          tools: [
            { toolCallId: 'a', kind: 'read', title: 'x', status: 'completed', locations: [], content: [] },
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe('formatLocations', () => {
  it('shows the basename, line and an overflow count', () => {
    expect(formatLocations([])).toBe('');
    expect(formatLocations([{ path: '/t/b/server.ts' }])).toBe('server.ts');
    expect(formatLocations([{ path: '/t/b/server.ts', line: 126 }])).toBe('server.ts:126');
    expect(formatLocations([{ path: '/t/b/server.ts' }, { path: '/t/c.ts' }])).toBe('server.ts +1');
  });
});

describe('permission options', () => {
  const options = [
    { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
    { optionId: 'allow_always', name: 'Always Allow', kind: 'allow_always' },
    { optionId: 'allow', name: 'Allow Once', kind: 'allow_once' },
  ];

  it('orders allow_once, allow_always, reject_once, reject_always whatever the adapter sent', () => {
    // claude sends them Deny / Allow Once / Always Allow; the UI must not.
    expect(orderPermissionOptions(options).map((o) => o.optionId)).toEqual([
      'allow',
      'allow_always',
      'reject',
    ]);
  });

  it('keeps an unknown kind last rather than dropping it', () => {
    const withUnknown = [...options, { optionId: 'weird', name: 'Weird', kind: 'something_else' }];
    expect(orderPermissionOptions(withUnknown).at(-1)?.optionId).toBe('weird');
  });

  it('maps kinds to button tones', () => {
    expect(permissionButtonTone('allow_once')).toBe('primary');
    expect(permissionButtonTone('allow_always')).toBe('secondary');
    expect(permissionButtonTone('reject_once')).toBe('destructive');
    expect(permissionButtonTone('reject_always')).toBe('destructive');
  });

  it('prefers allow_once, then allow_always, then the first option', () => {
    expect(preferredAllowOption(options).optionId).toBe('allow');
    expect(
      preferredAllowOption([
        { optionId: 'allow_always', name: 'Always', kind: 'allow_always' },
        { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
      ]).optionId,
    ).toBe('allow_always');
    expect(
      preferredAllowOption([{ optionId: 'reject', name: 'Deny', kind: 'reject_once' }]).optionId,
    ).toBe('reject');
  });
});

describe('pinnedPlan', () => {
  const base = {
    ticketId: 'a',
    agentId: 'claude',
    ts: '2026-09-02T12:00:00.000Z',
    seqLast: 0,
    sealed: false,
  };
  const running = { ...base, itemId: 't1:0', turnId: 't1', type: 'turn.status', state: 'running', seqFirst: 0, startedAt: base.ts } as ChatItem;
  const ended = { ...base, itemId: 't1:0', turnId: 't1', type: 'turn.status', state: 'ended', seqFirst: 0, startedAt: base.ts } as ChatItem;
  const plan = { ...base, itemId: 't1:1', turnId: 't1', type: 'agent.plan', entries: [], seqFirst: 1 } as ChatItem;

  it('pins the plan of a turn that is still running', () => {
    expect(pinnedPlan([running, plan])?.itemId).toBe('t1:1');
  });

  it('drops the pin once the turn ends', () => {
    expect(pinnedPlan([ended, plan])).toBeNull();
    expect(pinnedPlan([])).toBeNull();
  });

  it('ignores a plan belonging to a different turn', () => {
    const otherPlan = { ...plan, itemId: 't2:1', turnId: 't2' } as ChatItem;
    expect(pinnedPlan([running, otherPlan])).toBeNull();
  });
});

describe('summarizeTurn', () => {
  it('reads like the §5.3 status row', () => {
    expect(
      summarizeTurn({ agentName: 'Claude', durationMs: 182_000, totalTokens: 41_200, cost: 0.19 }),
    ).toBe('Claude · 3m 02s · 41.2k tokens · $0.19');
  });

  it('appends a non-default stop reason and omits missing parts', () => {
    expect(summarizeTurn({ agentName: 'Codex', durationMs: 1_000, stopReason: 'cancelled' })).toBe(
      'Codex · 1s · cancelled',
    );
    expect(summarizeTurn({ agentName: 'Codex', stopReason: 'end_turn' })).toBe('Codex');
  });
});

describe('agentColorClasses', () => {
  it('falls back for an unknown colour rather than emitting a broken class', () => {
    expect(agentColorClasses('violet')).toContain('violet');
    expect(agentColorClasses('chartreuse')).toBe('bg-muted text-muted-foreground');
  });
});

describe('stripAnsi', () => {
  it('removes CSI escapes', () => {
    expect(stripAnsi('\u001B[31mred\u001B[0m')).toBe('red');
    expect(stripAnsi('\u001B[1;32mok\u001B[0m done')).toBe('ok done');
  });

  it('leaves ordinary bracketed text alone', () => {
    expect(stripAnsi('see [the docs](http://x) and array[0]')).toBe('see [the docs](http://x) and array[0]');
  });
});

describe('toDiffLines', () => {
  it('marks added, removed and context lines', () => {
    const lines = toDiffLines('a\nb\n', 'a\nc\n');
    expect(lines).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'c' },
    ]);
  });

  it('treats a null oldText as a whole-file add', () => {
    expect(toDiffLines(null, 'x\ny\n')).toEqual([
      { kind: 'add', text: 'x' },
      { kind: 'add', text: 'y' },
    ]);
  });
});

describe('raw I/O', () => {
  it('pretty-prints objects and passes strings through', () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(prettyJson('plain')).toBe('plain');
    expect(prettyJson(undefined)).toBe('');
  });

  it('survives a circular value', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(prettyJson(circular)).toBe('[object Object]');
  });

  it('caps oversized bodies with a visible marker', () => {
    const big = 'x'.repeat(RAW_IO_CAP + 10);
    const capped = capRawIo(big);
    expect(capped.length).toBeLessThan(big.length + 60);
    expect(capped).toContain('truncated at');
    expect(capRawIo('small')).toBe('small');
  });
});

/**
 * Task 7 — the chat-versus-activity split (Decision 5) is presentation only:
 * the chat column keeps the conversation, and each turn's thoughts and full
 * tool rows go behind a disclosure on that turn's status row.
 */
describe('groupByTurn', () => {
  const row = (over: Partial<ChatItem> & Pick<ChatItem, 'itemId' | 'type'>): ChatItem =>
    ({
      ticketId: 'a1',
      turnId: 't1',
      agentId: 'planner',
      ts: '2026-09-02T12:00:00.000Z',
      seqFirst: 0,
      seqLast: 0,
      sealed: true,
      ...over,
    }) as ChatItem;

  it('collects a turn’s thoughts and work cards under its turn id', () => {
    const groups = groupByTurn([
      row({ itemId: 'a', type: 'agent.thought', text: 'hmm' } as never),
      row({
        itemId: 'b',
        type: 'agent.work',
        tools: [{ toolCallId: 'x' }, { toolCallId: 'y' }],
        summary: {},
      } as never),
      row({ itemId: 'c', type: 'agent.message', text: 'done' } as never),
      row({ itemId: 'd', turnId: 't2', type: 'agent.thought', text: 'other turn' } as never),
    ]);
    expect(groups.get('t1')?.thoughts.map((i) => i.itemId)).toEqual(['a']);
    expect(groups.get('t1')?.work.map((i) => i.itemId)).toEqual(['b']);
    expect(groups.get('t1')?.toolCount).toBe(2);
    expect(groups.get('t2')?.thoughts).toHaveLength(1);
  });

  it('ignores items outside any turn', () => {
    const groups = groupByTurn([row({ itemId: 'a', turnId: null, type: 'agent.thought' } as never)]);
    expect(groups.size).toBe(0);
  });

  it('summarises what the disclosure holds', () => {
    expect(activitySummary({ thoughts: [1, 2], work: [1], toolCount: 5 } as never)).toBe(
      '2 thoughts · 5 tool calls',
    );
    expect(activitySummary({ thoughts: [1], work: [], toolCount: 1 } as never)).toBe(
      '1 thought · 1 tool call',
    );
    expect(activitySummary({ thoughts: [], work: [], toolCount: 0 } as never)).toBe('');
  });
});

describe('isChatColumnItem', () => {
  it('keeps the conversation and drops thoughts', () => {
    const kinds: Array<ChatItem['type']> = [
      'user.message',
      'agent.message',
      'handoff',
      'agent.work',
      'agent.plan',
      'permission.request',
      'turn.status',
      'system',
    ];
    for (const type of kinds) {
      expect(isChatColumnItem({ type } as ChatItem)).toBe(true);
    }
    expect(isChatColumnItem({ type: 'agent.thought' } as ChatItem)).toBe(false);
  });
});

describe('rankAgentTokens', () => {
  it('offers every attached agent for a bare @', () => {
    expect(rankAgentTokens('', ['planner', 'implementer'])).toEqual(['planner', 'implementer']);
  });

  it('puts prefix matches before substring matches, case-insensitively', () => {
    expect(rankAgentTokens('IM', ['planner', 'implementer', 'trim'])).toEqual(['implementer', 'trim']);
  });

  it('offers nothing when nothing matches', () => {
    expect(rankAgentTokens('zzz', ['planner'])).toEqual([]);
  });
});
