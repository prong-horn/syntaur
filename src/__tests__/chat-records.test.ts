import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildTurnProgressEntry,
  clipExcerpt,
  escapeHeadings,
  fileChatRecord,
  formatDurationMs,
  provenanceLine,
} from '../chat/records.js';
import { parseProgress } from '../dashboard/parser.js';
import { parseComments } from '../dashboard/parser.js';
import { parseDecisionRecord } from '../dashboard/parser.js';
import { HUMAN_AGENT_ID } from '../chat/types.js';
import type { AgentMessageItem, AgentWorkItem, ChatItem } from '../chat/types.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'chat-records-test-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function baseItem(overrides: Partial<ChatItem> & { type: ChatItem['type'] }): ChatItem {
  return {
    itemId: 'item-1',
    ticketId: 'a1',
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

  it('builds a full entry for a work turn with edit, execute and read rows', async () => {
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

    const expected = [
      '**@claude** worked 3m 02s in chat — edited 1 file(s), ran 1 command(s), read 3.',
      'Edited: `src/a.ts`',
      '> Here is what I did.',
      `Chat turn \`${turnId}\`.`,
    ].join('\n\n');
    expect(entry).toBe(expected);

    await fileChatRecord({
      ticketDir: testDir,
      ticketRef: 'demo',
      record: { kind: 'progress', body: entry! },
      source: { agentId: 'claude', ts: '2026-09-07T12:00:00Z' },
    });
    const progressMd = await readFile(join(testDir, 'progress.md'), 'utf-8');
    const parsed = parseProgress(progressMd);
    expect(parsed.entryCount).toBe(1);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.body).toContain(entry!);
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
    const expected = [
      '**@claude** worked 5s in chat — edited 0 file(s), ran 1 command(s), read 0.',
      '> Done.',
      `Chat turn \`${turnId}\`.`,
    ].join('\n\n');
    expect(entry).toBe(expected);
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

describe('provenanceLine', () => {
  it('names the agent or the human filer', () => {
    expect(provenanceLine({ agentId: 'claude', ts: '2026-09-07T13:25:06Z' })).toBe(
      '_Filed from chat (@claude, 2026-09-07T13:25:06Z)._',
    );
    expect(provenanceLine({ agentId: HUMAN_AGENT_ID, ts: '2026-09-07T13:25:06Z' })).toBe(
      '_Filed from chat (you, 2026-09-07T13:25:06Z)._',
    );
  });
});

describe('escapeHeadings', () => {
  it('escapes markdown headings but leaves hashtags and fenced code alone', () => {
    expect(escapeHeadings('## Sub\n# Top')).toBe('\\## Sub\n\\# Top');
    expect(escapeHeadings('#hashtag')).toBe('#hashtag');
    expect(escapeHeadings('```\n## not escaped in fence\n```')).toBe('```\n\\## not escaped in fence\n```');
  });
});

describe('fileChatRecord', () => {
  const source = { agentId: 'claude', ts: '2026-09-07T13:25:06Z' };

  it('files decision, progress and comment records with provenance', async () => {
    const decision = await fileChatRecord({
      ticketDir: testDir,
      ticketRef: 'demo',
      record: { kind: 'decision', title: 'Use X', body: 'Because it is simpler.' },
      source,
    });
    expect(decision).toEqual({ kind: 'decision', ref: 'Decision 1', label: 'Decision 1: Use X' });
    const decisionMd = await readFile(join(testDir, 'decision-record.md'), 'utf-8');
    expect(decisionMd).toContain('## Use X');
    expect(decisionMd).toContain('**Recorded:**');
    expect(decisionMd.trimEnd().endsWith(provenanceLine(source))).toBe(true);

    const progress = await fileChatRecord({
      ticketDir: testDir,
      ticketRef: 'demo',
      record: { kind: 'progress', body: 'Shipped the feature.' },
      source,
    });
    expect(progress.kind).toBe('progress');
    const progressMd = await readFile(join(testDir, 'progress.md'), 'utf-8');
    expect(parseProgress(progressMd).entryCount).toBe(1);
    expect(progressMd).toContain(provenanceLine(source));

    const comment = await fileChatRecord({
      ticketDir: testDir,
      ticketRef: 'demo',
      record: { kind: 'comment', body: 'Looks good.', commentType: 'question' },
      source: { agentId: HUMAN_AGENT_ID, ts: '2026-09-07T13:30:00Z' },
    });
    expect(comment.kind).toBe('comment');
    const commentsMd = await readFile(join(testDir, 'comments.md'), 'utf-8');
    const parsed = parseComments(commentsMd);
    expect(parsed.entries[0]?.author).toBe('human');
    expect(parsed.entries[0]?.type).toBe('question');
    expect(parsed.entries[0]?.resolved).toBe(false);
    expect(commentsMd).not.toContain('Filed from chat');
  });

  it('escapes progress headings so parseProgress sees one entry', async () => {
    await fileChatRecord({
      ticketDir: testDir,
      ticketRef: 'demo',
      record: { kind: 'progress', body: '## Sub\nStill one entry.' },
      source,
    });
    const progressMd = await readFile(join(testDir, 'progress.md'), 'utf-8');
    const parsed = parseProgress(progressMd);
    expect(parsed.entryCount).toBe(1);
    expect(parsed.entries).toHaveLength(1);
    expect(progressMd).toContain('\\## Sub');
  });
});
