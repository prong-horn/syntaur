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
  assignmentUpdated: '',
};

describe('InboxPage', () => {
  it('renders a flat list without section headings or CLI code lines', async () => {
    vi.resetModules();
    vi.doMock('../../hooks/useInbox', () => ({
      useInbox: () => ({
        items: [
          { ...base, category: 'review' as const, acceptCommand: 'complete', reopenCommand: 'start' },
          base,
        ],
        counts: { question: 1, review: 1, 'plan-approval': 0 },
        total: 2,
        loading: false,
        error: null,
        refetch: () => {},
      }),
    }));
    vi.doMock('../../hooks/useProjects', () => ({
      useProjects: () => ({ data: [{ slug: 'demo', title: 'Demo' }], loading: false, error: null }),
    }));
    vi.doMock('../../lib/chat-api', () => ({
      fetchChatAgents: async () => [],
    }));
    const { InboxPage } = await import('../InboxPage');
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    );
    expect(html).not.toContain('<code');
    expect(html).not.toContain('Questions');
    expect(html).not.toContain('Review');
    expect(html).toContain('Needs me');
    expect(html).toContain('2 waiting');
  });

  it('renders the project select with slugs from useProjects', async () => {
    vi.resetModules();
    vi.doMock('../../hooks/useInbox', () => ({
      useInbox: () => ({
        items: [base],
        counts: { question: 1, review: 0, 'plan-approval': 0 },
        total: 1,
        loading: false,
        error: null,
        refetch: () => {},
      }),
    }));
    vi.doMock('../../hooks/useProjects', () => ({
      useProjects: () => ({
        data: [{ slug: 'alpha', title: 'Alpha' }, { slug: 'demo', title: 'Demo' }],
        loading: false,
        error: null,
      }),
    }));
    vi.doMock('../../lib/chat-api', () => ({
      fetchChatAgents: async () => [],
    }));
    const { InboxPage } = await import('../InboxPage');
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    );
    expect(html).toContain('All projects');
    expect(html).toContain('alpha');
    expect(html).toContain('demo');
  });

  it('renders the empty state naming the four sources', async () => {
    vi.resetModules();
    vi.doMock('../../hooks/useInbox', () => ({
      useInbox: () => ({
        items: [],
        counts: { question: 0, review: 0, 'plan-approval': 0 },
        total: 0,
        loading: false,
        error: null,
        refetch: () => {},
      }),
    }));
    vi.doMock('../../hooks/useProjects', () => ({
      useProjects: () => ({ data: [], loading: false, error: null }),
    }));
    vi.doMock('../../lib/chat-api', () => ({
      fetchChatAgents: async () => [],
    }));
    const { InboxPage } = await import('../InboxPage');
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    );
    expect(html).toContain('Nothing is waiting on you');
    expect(html).toContain('plan needs approval');
    expect(html).toContain('permission card');
  });

  it('renders anchor ids on list rows', async () => {
    vi.resetModules();
    vi.doMock('../../hooks/useInbox', () => ({
      useInbox: () => ({
        items: [
          {
            ...base,
            category: 'review' as const,
            commentId: undefined,
            acceptCommand: 'complete',
            reopenCommand: 'start',
          },
          {
            ...base,
            commentId: undefined,
            chat: { kind: 'reply' as const, itemId: 'item:colon', agentId: 'claude' },
          },
        ],
        counts: { question: 1, review: 1, 'plan-approval': 0 },
        total: 2,
        loading: false,
        error: null,
        refetch: () => {},
      }),
    }));
    vi.doMock('../../hooks/useProjects', () => ({
      useProjects: () => ({ data: [], loading: false, error: null }),
    }));
    vi.doMock('../../lib/chat-api', () => ({
      fetchChatAgents: async () => [],
      authorOf: () => null,
    }));
    const { InboxPage } = await import('../InboxPage');
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    );
    expect(html).toContain('id="review:uuid-1"');
    expect(html).toContain('id="item:colon"');
  });

  it('shows Enable notifications when permission is default', async () => {
    const orig = globalThis.Notification;
    globalThis.Notification = Object.assign(
      function StubNotification() {},
      {
        permission: 'default',
        requestPermission: async () => 'default',
      },
    ) as unknown as typeof Notification;
    try {
      vi.resetModules();
      vi.doMock('../../hooks/useInbox', () => ({
        useInbox: () => ({
          items: [base],
          counts: { question: 1, review: 0, 'plan-approval': 0 },
          total: 1,
          loading: false,
          error: null,
          refetch: () => {},
        }),
      }));
      vi.doMock('../../hooks/useProjects', () => ({
        useProjects: () => ({ data: [], loading: false, error: null }),
      }));
      vi.doMock('../../lib/chat-api', () => ({
        fetchChatAgents: async () => [],
      }));
      const { InboxPage } = await import('../InboxPage');
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <InboxPage />
        </MemoryRouter>,
      );
      expect(html).toContain('Enable notifications');
    } finally {
      globalThis.Notification = orig;
    }
  });

  it('hides Enable notifications when permission is granted', async () => {
    const orig = globalThis.Notification;
    globalThis.Notification = Object.assign(
      function StubNotification() {},
      {
        permission: 'granted',
        requestPermission: async () => 'granted',
      },
    ) as unknown as typeof Notification;
    try {
      vi.resetModules();
      vi.doMock('../../hooks/useInbox', () => ({
        useInbox: () => ({
          items: [base],
          counts: { question: 1, review: 0, 'plan-approval': 0 },
          total: 1,
          loading: false,
          error: null,
          refetch: () => {},
        }),
      }));
      vi.doMock('../../hooks/useProjects', () => ({
        useProjects: () => ({ data: [], loading: false, error: null }),
      }));
      vi.doMock('../../lib/chat-api', () => ({
        fetchChatAgents: async () => [],
      }));
      const { InboxPage } = await import('../InboxPage');
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <InboxPage />
        </MemoryRouter>,
      );
      expect(html).not.toContain('Enable notifications');
    } finally {
      globalThis.Notification = orig;
    }
  });

  it('hides Enable notifications when Notification is unavailable', async () => {
    const orig = globalThis.Notification;
    // @ts-expect-error SSR / unsupported environment
    delete globalThis.Notification;
    try {
      vi.resetModules();
      vi.doMock('../../hooks/useInbox', () => ({
        useInbox: () => ({
          items: [base],
          counts: { question: 1, review: 0, 'plan-approval': 0 },
          total: 1,
          loading: false,
          error: null,
          refetch: () => {},
        }),
      }));
      vi.doMock('../../hooks/useProjects', () => ({
        useProjects: () => ({ data: [], loading: false, error: null }),
      }));
      vi.doMock('../../lib/chat-api', () => ({
        fetchChatAgents: async () => [],
      }));
      const { InboxPage } = await import('../InboxPage');
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <InboxPage />
        </MemoryRouter>,
      );
      expect(html).not.toContain('Enable notifications');
    } finally {
      globalThis.Notification = orig;
    }
  });
});
