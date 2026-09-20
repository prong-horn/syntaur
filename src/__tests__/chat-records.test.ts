import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
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
import { parseLogEntries } from '../ticket-templates/log-reader.js';
import { HUMAN_AGENT_ID } from '../chat/types.js';
import {
  closeSessionDb,
  initSessionDb,
  resetSessionDb,
} from '../dashboard/session-db.js';
import { fileExists } from '../utils/fs.js';
import type { AgentMessageItem, AgentWorkItem, ChatItem } from '../chat/types.js';

let testDir: string;

const TICKET_ID = 'demo-1';

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'chat-records-test-'));
  await writeFile(
    join(testDir, 'ticket.md'),
    `---
id: ${TICKET_ID}
slug: demo
title: Demo
template: feature
status: in_progress
---
`,
    'utf-8',
  );
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
      ticketId: TICKET_ID,
      record: { kind: 'progress', body: entry! },
      source: { agentId: 'claude', ts: '2026-09-07T12:00:00Z' },
    });
    const journalMd = await readFile(join(testDir, 'journal.md'), 'utf-8');
    const parsed = parseLogEntries(journalMd);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.body).toContain(entry!);
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

  it('files decision, progress and question records with provenance', async () => {
    const decision = await fileChatRecord({
      ticketDir: testDir,
      ticketRef: 'demo',
      ticketId: TICKET_ID,
      record: { kind: 'decision', body: 'Because it is simpler.' },
      source,
    });
    expect(decision.kind).toBe('decision');
    expect(decision.label).toBe('a decision entry');
    const journalAfterDecision = await readFile(join(testDir, 'journal.md'), 'utf-8');
    expect(journalAfterDecision).toContain('· decision · claude');
    expect(journalAfterDecision).toContain('Because it is simpler.');
    expect(journalAfterDecision.trimEnd().endsWith(provenanceLine(source))).toBe(true);

    const progress = await fileChatRecord({
      ticketDir: testDir,
      ticketRef: 'demo',
      ticketId: TICKET_ID,
      record: { kind: 'progress', body: 'Shipped the feature.' },
      source,
    });
    expect(progress.kind).toBe('progress');
    const journalAfterProgress = await readFile(join(testDir, 'journal.md'), 'utf-8');
    expect(parseLogEntries(journalAfterProgress).filter((e) => e.type === 'progress')).toHaveLength(1);
    expect(journalAfterProgress).toContain(provenanceLine(source));

    const question = await fileChatRecord({
      ticketDir: testDir,
      ticketRef: 'demo',
      ticketId: TICKET_ID,
      record: { kind: 'question', body: 'Looks good?' },
      source: { agentId: HUMAN_AGENT_ID, ts: '2026-09-07T13:30:00Z' },
    });
    expect(question.kind).toBe('question');
    const journalAfterQuestion = await readFile(join(testDir, 'journal.md'), 'utf-8');
    const entries = parseLogEntries(journalAfterQuestion);
    const filedQuestion = entries.find((e) => e.type === 'question')!;
    expect(filedQuestion.author).toBe('human');
    expect(filedQuestion.body).toContain('Looks good?');
    expect(journalAfterQuestion).toContain('_Filed from chat (you,');
  });

  it('files a note entry on a feature ticket', async () => {
    const note = await fileChatRecord({
      ticketDir: testDir,
      ticketRef: 'demo',
      ticketId: TICKET_ID,
      record: { kind: 'note', body: 'A note from chat.' },
      source,
    });
    expect(note.label).toBe('a note entry');
    const journal = await readFile(join(testDir, 'journal.md'), 'utf-8');
    expect(journal).toContain('· note · claude');
    expect(journal).toContain('A note from chat.');
  });

  it('files typed entries at the top of legacy progress.md', async () => {
    const legacyDir = await mkdtemp(join(tmpdir(), 'chat-records-legacy-'));
    await writeFile(
      join(legacyDir, 'ticket.md'),
      `---
id: LEG-1
slug: legacy
template: legacy
status: in_progress
---
`,
    );
    await writeFile(
      join(legacyDir, 'progress.md'),
      `---
ticket: legacy
entryCount: 0
updated: "2026-01-01T00:00:00Z"
---

# Progress

No progress yet.
`,
    );
    await fileChatRecord({
      ticketDir: legacyDir,
      ticketRef: 'legacy',
      ticketId: 'LEG-1',
      record: { kind: 'progress', body: 'Legacy baton from chat.' },
      source,
    });
    const progress = await readFile(join(legacyDir, 'progress.md'), 'utf-8');
    expect(progress).toContain('· progress · claude');
    const h1 = progress.indexOf('# Progress');
    expect(progress.indexOf('Legacy baton from chat.')).toBeGreaterThan(h1);
    await rm(legacyDir, { recursive: true, force: true });
  });

  it('files a chat note on quick templates without a log role', async () => {
    const quickDir = await mkdtemp(join(tmpdir(), 'chat-records-quick-'));
    resetSessionDb();
    initSessionDb(join(quickDir, 'syntaur.db'));
    await writeFile(
      join(quickDir, 'ticket.md'),
      `---
id: Q-1
slug: quick
template: quick
status: draft
---
`,
    );
    const filed = await fileChatRecord({
      ticketDir: quickDir,
      ticketRef: 'quick',
      ticketId: 'Q-1',
      record: { kind: 'note', body: 'Quick chat note.' },
      source,
    });
    expect(filed.label).toBe('chat note');
    expect(await fileExists(join(quickDir, 'chat', 'events.jsonl'))).toBe(true);
    expect(await readFile(join(quickDir, 'chat', 'events.jsonl'), 'utf-8')).toContain('Quick chat note.');
    closeSessionDb();
    resetSessionDb();
    await rm(quickDir, { recursive: true, force: true });
  });

  it('escapes progress headings so parseLogEntries sees one entry', async () => {
    await fileChatRecord({
      ticketDir: testDir,
      ticketRef: 'demo',
      ticketId: TICKET_ID,
      record: { kind: 'progress', body: '## Sub\nStill one entry.' },
      source,
    });
    const journalMd = await readFile(join(testDir, 'journal.md'), 'utf-8');
    const parsed = parseLogEntries(journalMd);
    expect(parsed).toHaveLength(1);
    expect(journalMd).toContain('\\## Sub');
  });
});
