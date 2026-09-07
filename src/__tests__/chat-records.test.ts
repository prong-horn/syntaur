import { describe, it, expect } from 'vitest';
import {
  buildTurnProgressEntry,
  clipExcerpt,
  formatDurationMs,
} from '../chat/records.js';
import type { AgentMessageItem, AgentWorkItem, ChatItem } from '../chat/types.js';

function baseItem(overrides: Partial<ChatItem> & { type: ChatItem['type'] }): ChatItem {
  return {
    itemId: 'item-1',
    assignmentId: 'a1',
    turnId: 'turn-1',
    agentId: 'claude',
    ts: '2026-09-07T12:00:00Z',
    seqFirst: 1,
    seqLast: 1,
    sealed: true,
    ...overrides,
  } as ChatItem;
}

function workItem(
  tools: AgentWorkItem['tools'],
  summary: AgentWorkItem['summary'],
): AgentWorkItem {
  return {
    ...baseItem({ type: 'agent.work', itemId: 'work-1' }),
    type: 'agent.work',
    tools,
    summary,
  };
}

function messageItem(text: string, sealed = true): AgentMessageItem {
  return {
    ...baseItem({ type: 'agent.message', itemId: 'msg-1', sealed }),
    type: 'agent.message',
    messageId: 'm1',
    text,
  };
}

describe('formatDurationMs', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDurationMs(41_000)).toBe('41s');
    expect(formatDurationMs(182_000)).toBe('3m 02s');
    expect(formatDurationMs(3_780_000)).toBe('1h 03m');
  });
});

describe('clipExcerpt', () => {
  it('cuts at a paragraph boundary and appends an ellipsis', () => {
    const text = 'First paragraph.\n\nSecond paragraph that makes this too long.';
    const clipped = clipExcerpt(text, 30);
    expect(clipped).toBe('First paragraph.…');
  });
});

describe('buildTurnProgressEntry', () => {
  const turnId = 'abc123';

  it('builds a full entry for a work turn with edit, execute and read rows', () => {
    const items: ChatItem[] = [
      workItem(
        [
          { toolCallId: 't1', kind: 'edit', title: 'Edit', status: 'completed', locations: [{ path: '/w/src/a.ts' }], content: [] },
          { toolCallId: 't2', kind: 'execute', title: 'Run', status: 'completed', locations: [], content: [] },
          { toolCallId: 't3', kind: 'read', title: 'Read', status: 'completed', locations: [], content: [] },
          { toolCallId: 't4', kind: 'read', title: 'Read', status: 'completed', locations: [], content: [] },
          { toolCallId: 't5', kind: 'read', title: 'Read', status: 'completed', locations: [], content: [] },
        ],
        { reads: 3, edits: 1, runs: 1, failed: 0, durationMs: 182_000 },
      ),
      messageItem('Here is what I did.'),
    ];

    const entry = buildTurnProgressEntry({
      agentId: 'claude',
      durationMs: 182_000,
      items,
      cwd: '/w',
      turnId,
    });

    expect(entry).toContain('**@claude** worked 3m 02s in chat — edited 1 file(s), ran 1 command(s), read 3.');
    expect(entry).toContain('Edited: `src/a.ts`');
    expect(entry).toContain('> Here is what I did.');
    expect(entry).toContain(`Chat turn \`${turnId}\`.`);
  });

  it('returns null for a read-only turn', () => {
    const items: ChatItem[] = [
      workItem(
        [{ toolCallId: 't1', kind: 'read', title: 'Read', status: 'completed', locations: [], content: [] }],
        { reads: 1, edits: 0, runs: 0, failed: 0, durationMs: 1000 },
      ),
    ];
    expect(
      buildTurnProgressEntry({ agentId: 'claude', durationMs: 1000, items, cwd: '/w', turnId }),
    ).toBeNull();
  });

  it('omits the Edited line for a run-only turn', () => {
    const items: ChatItem[] = [
      workItem(
        [{ toolCallId: 't1', kind: 'execute', title: 'Run', status: 'completed', locations: [], content: [] }],
        { reads: 0, edits: 0, runs: 1, failed: 0, durationMs: 5000 },
      ),
      messageItem('Done.'),
    ];
    const entry = buildTurnProgressEntry({
      agentId: 'claude',
      durationMs: 5000,
      items,
      cwd: '/w',
      turnId,
    });
    expect(entry).not.toContain('Edited:');
    expect(entry).toContain('ran 1 command(s)');
  });

  it('lists eight edited paths then +N more', () => {
    const tools = Array.from({ length: 9 }, (_, i) => ({
      toolCallId: `t${i}`,
      kind: 'edit' as const,
      title: 'Edit',
      status: 'completed' as const,
      locations: [{ path: `/w/f${i}.ts` }],
      content: [],
    }));
    const items: ChatItem[] = [
      workItem(tools, { reads: 0, edits: 9, runs: 0, failed: 0, durationMs: 1000 }),
    ];
    const entry = buildTurnProgressEntry({
      agentId: 'claude',
      durationMs: 1000,
      items,
      cwd: '/w',
      turnId,
    });
    expect(entry).toContain('`f0.ts`');
    expect(entry).toContain('`f7.ts`');
    expect(entry).not.toContain('`f8.ts`');
    expect(entry).toContain('+1 more');
  });

  it('keeps a path outside cwd absolute', () => {
    const items: ChatItem[] = [
      workItem(
        [
          {
            toolCallId: 't1',
            kind: 'edit',
            title: 'Edit',
            status: 'completed',
            locations: [{ path: '/elsewhere/out.ts' }],
            content: [],
          },
        ],
        { reads: 0, edits: 1, runs: 0, failed: 0, durationMs: 1000 },
      ),
    ];
    const entry = buildTurnProgressEntry({
      agentId: 'claude',
      durationMs: 1000,
      items,
      cwd: '/w',
      turnId,
    });
    expect(entry).toContain('`/elsewhere/out.ts`');
  });

  it('shows failed count only when greater than zero', () => {
    const withFailed: ChatItem[] = [
      workItem(
        [{ toolCallId: 't1', kind: 'execute', title: 'Run', status: 'failed', locations: [], content: [] }],
        { reads: 0, edits: 0, runs: 1, failed: 1, durationMs: 1000 },
      ),
    ];
    expect(
      buildTurnProgressEntry({ agentId: 'claude', durationMs: 1000, items: withFailed, cwd: '/w', turnId }),
    ).toContain('(1 failed)');

    const withoutFailed: ChatItem[] = [
      workItem(
        [{ toolCallId: 't1', kind: 'execute', title: 'Run', status: 'completed', locations: [], content: [] }],
        { reads: 0, edits: 0, runs: 1, failed: 0, durationMs: 1000 },
      ),
    ];
    expect(
      buildTurnProgressEntry({ agentId: 'claude', durationMs: 1000, items: withoutFailed, cwd: '/w', turnId }),
    ).not.toContain('failed');
  });

  it('uses (no reply text) when the turn had no sealed reply', () => {
    const items: ChatItem[] = [
      workItem(
        [{ toolCallId: 't1', kind: 'edit', title: 'Edit', status: 'completed', locations: [{ path: '/w/a.ts' }], content: [] }],
        { reads: 0, edits: 1, runs: 0, failed: 0, durationMs: 1000 },
      ),
    ];
    const entry = buildTurnProgressEntry({
      agentId: 'claude',
      durationMs: 1000,
      items,
      cwd: '/w',
      turnId,
    });
    expect(entry).toContain('> (no reply text)');
  });
});
