import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { JournalTab } from '../JournalTab';
import type { TicketTemplateFileDetail } from '../../hooks/useProjects';

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
});
