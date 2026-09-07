import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { InboxItem } from '../../lib/inbox';

const base: InboxItem = {
  project: 'demo',
  assignmentSlug: 'task',
  assignmentId: 'uuid-1',
  title: 'Needs me',
  category: 'question',
  since: '2026-06-16T00:00:00Z',
  ageMs: 60_000,
  summary: 'Which name?',
  commentId: 'c1',
  action: { verb: 'Answer', command: 'syntaur comment task "<answer>" --reply-to c1 --project demo' },
};

function renderWithItems(items: InboxItem[]): string {
  vi.doMock('../../hooks/useInbox', () => ({
    useInbox: () => ({ items, total: items.length, loading: false, error: null, refetch: () => {} }),
  }));
  return import('../InboxPage').then(({ InboxPage }) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    ),
  ) as unknown as string;
}

describe('InboxPage chat rows', () => {
  it('renders a chat row with badge, chat link and no reply textarea', async () => {
    vi.resetModules();
    vi.doMock('../../hooks/useInbox', () => ({
      useInbox: () => ({
        items: [
          {
            ...base,
            chat: { kind: 'reply', itemId: 'item-1', agentId: 'claude' },
            action: {
              verb: 'Open chat',
              command: 'http://localhost:4800/projects/demo/assignments/task?tab=chat#item-1',
            },
          },
        ],
        total: 1,
        loading: false,
        error: null,
        refetch: () => {},
      }),
    }));
    const { InboxPage } = await import('../InboxPage');
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    );
    expect(html).toContain('@claude asked');
    expect(html).toContain('Open chat');
    expect(html).not.toContain('Reply inline');
    expect(html).toContain('?tab=chat#item-1');
  });

  it('keeps the inline reply textarea for plain questions', async () => {
    vi.resetModules();
    vi.doMock('../../hooks/useInbox', () => ({
      useInbox: () => ({
        items: [base],
        total: 1,
        loading: false,
        error: null,
        refetch: () => {},
      }),
    }));
    const { InboxPage } = await import('../InboxPage');
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    );
    expect(html).toContain('Reply inline');
    expect(html).toContain('Open to answer');
  });
});
