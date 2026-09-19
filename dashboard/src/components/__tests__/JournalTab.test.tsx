import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  JournalTab,
  buildJournalAppendPayload,
  mergeJournalEntriesAfterAppend,
  validateJournalAppend,
} from '../ticket/JournalTab';
import type { TicketLogEntryDetail, TicketTemplateFileDetail } from '../../hooks/useProjects';

const file: TicketTemplateFileDetail = {
  path: 'journal.md',
  role: 'log',
  writer: 'cli',
  description: 'Append-only log',
  state: '3 entries · last progress 1h',
  exists: true,
  createOn: 'ticket-creation',
  body: null,
  entryTypes: ['progress', 'note', 'review', 'answer', 'question'],
  logEntries: [
    {
      timestamp: '2026-04-07T12:00:00Z',
      type: 'progress',
      author: 'human',
      firstLine: 'Shipped',
      body: 'Shipped',
    },
    {
      timestamp: '2026-04-07T13:00:00Z',
      type: 'review',
      author: 'human',
      firstLine: 'Looks good',
      body: 'Looks good',
      keys: { verdict: 'approve · open: high=0 medium=0' },
    },
    {
      timestamp: '2026-04-07T10:00:00Z',
      type: 'question',
      author: 'human',
      firstLine: 'Waiting?',
      body: 'Waiting?',
    },
  ],
};

describe('JournalTab', () => {
  it('renders filter chips, entries, and a verdict badge on review entries', () => {
    const html = renderToStaticMarkup(<JournalTab ticketId="TP-1" file={file} />);
    expect(html).toContain('All (3)');
    expect(html).toContain('approve');
    expect(html).toContain('Append entry');
    expect(html).toContain('Waiting?');
  });

  it('limits append types to the manifest entryTypes', () => {
    const html = renderToStaticMarkup(<JournalTab ticketId="TP-1" file={file} />);
    expect(html).toContain('progress');
    expect(html).not.toContain('<option value="handoff">');
  });

  it('merges appended entries into the displayed list', () => {
    const appended: TicketLogEntryDetail = {
      timestamp: '2026-04-07T14:00:00Z',
      type: 'progress',
      author: 'human',
      firstLine: 'Follow-up shipped',
      body: 'Follow-up shipped',
    };
    const merged = mergeJournalEntriesAfterAppend(file.logEntries ?? [], appended);
    expect(merged).toHaveLength(4);
    expect(merged.at(-1)?.body).toBe('Follow-up shipped');
  });

  it('requires a question for answer append and verdict/open for review append', () => {
    expect(validateJournalAppend('answer', 'An answer', '')).toBe('Select a question to answer');
    expect(validateJournalAppend('answer', 'An answer', '2026-04-07T10:00:00Z')).toBeNull();

    const review = buildJournalAppendPayload('review', 'Looks good', '', 'approve', '0', '1');
    expect(review).toEqual({
      type: 'review',
      body: 'Looks good',
      verdict: 'approve',
      open: 'high=0,medium=1',
    });
  });
});
