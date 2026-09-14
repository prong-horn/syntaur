import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { InboxItem } from '../../lib/inbox';

const base: InboxItem = {
  project: 'demo',
  ticketSlug: 'task',
  ticketId: 'uuid-1',
  title: 'Needs me',
  category: 'question',
  since: '2026-06-16T00:00:00Z',
  ageMs: 60_000,
  summary: 'Which name?',
  commentId: 'c1',
  action: { verb: 'Answer', command: 'syntaur comment task "<answer>" --reply-to c1 --project demo' },
  ticketUpdated: '',
};

function mockInboxWindow(window: '14d' | 'all' = '14d') {
  vi.doMock('../../hooks/useInboxWindow', () => ({
    useInboxWindow: () => ({
      window,
      setWindow: () => {},
      maxAgeDays: window === '14d' ? 14 : null,
    }),
  }));
}

describe('InboxPage', () => {
  it('renders a flat list without section headings or CLI code lines', async () => {
    vi.resetModules();
    mockInboxWindow();
    vi.doMock('../../hooks/useInbox', () => ({
      useInbox: () => ({
        items: [
          { ...base, category: 'review' as const, acceptCommand: 'done', reopenCommand: 'start' },
          base,
        ],
        counts: { question: 1, review: 1, 'plan-approval': 0 },
        total: 2,
        snoozedCount: 0,
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
    expect(html).toContain('Last 14 days');
    expect(html).toContain('aria-pressed="true"');
  });

  it('renders the project select with slugs from useProjects', async () => {
    vi.resetModules();
    mockInboxWindow();
    vi.doMock('../../hooks/useInbox', () => ({
      useInbox: () => ({
        items: [base],
        counts: { question: 1, review: 0, 'plan-approval': 0 },
        total: 1,
        snoozedCount: 0,
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
    mockInboxWindow('all');
    vi.doMock('../../hooks/useInbox', () => ({
      useInbox: () => ({
        items: [],
        counts: { question: 0, review: 0, 'plan-approval': 0 },
        total: 0,
        snoozedCount: 0,
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

  it('renders the 14-day empty state by default', async () => {
    vi.resetModules();
    mockInboxWindow('14d');
    vi.doMock('../../hooks/useInbox', () => ({
      useInbox: () => ({
        items: [],
        counts: { question: 0, review: 0, 'plan-approval': 0 },
        total: 0,
        snoozedCount: 0,
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
    expect(html).toContain('Nothing in the last 14 days');
    expect(html).toContain('Show all');
  });

  it('renders Snoozed foot in the empty branch when snoozedCount is positive', async () => {
    vi.resetModules();
    mockInboxWindow('all');
    vi.doMock('../../hooks/useInbox', () => ({
      useInbox: () => ({
        items: [],
        counts: { question: 0, review: 0, 'plan-approval': 0 },
        total: 0,
        snoozedCount: 2,
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
    expect(html).toContain('Snoozed (2)');
  });

  it('renders Snoozed foot in the list branch when snoozedCount is positive', async () => {
    vi.resetModules();
    mockInboxWindow();
    vi.doMock('../../hooks/useInbox', () => ({
      useInbox: () => ({
        items: [base],
        counts: { question: 1, review: 0, 'plan-approval': 0 },
        total: 1,
        snoozedCount: 2,
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
    expect(html).toContain('Snoozed (2)');
  });

  it('hides the Snoozed foot when snoozedCount is zero', async () => {
    vi.resetModules();
    mockInboxWindow();
    vi.doMock('../../hooks/useInbox', () => ({
      useInbox: () => ({
        items: [base],
        counts: { question: 1, review: 0, 'plan-approval': 0 },
        total: 1,
        snoozedCount: 0,
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
    expect(html).not.toContain('Snoozed (');
  });

  it('marks the All window button when useInboxWindow returns all', async () => {
    vi.resetModules();
    mockInboxWindow('all');
    vi.doMock('../../hooks/useInbox', () => ({
      useInbox: () => ({
        items: [base],
        counts: { question: 1, review: 0, 'plan-approval': 0 },
        total: 1,
        snoozedCount: 0,
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
    expect(html).toContain('aria-pressed="true">All</button>');
  });

  it('renders anchor ids on list rows', async () => {
    vi.resetModules();
    mockInboxWindow();
    vi.doMock('../../hooks/useInbox', () => ({
      useInbox: () => ({
        items: [
          {
            ...base,
            category: 'review' as const,
            commentId: undefined,
            acceptCommand: 'done',
            reopenCommand: 'start',
          },
          {
            ...base,
            commentId: undefined,
            chat: { kind: 'reply' as const, itemId: 'item~tilde', agentId: 'claude' },
          },
        ],
        counts: { question: 1, review: 1, 'plan-approval': 0 },
        total: 2,
        snoozedCount: 0,
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
    expect(html).toContain('id="uuid-1~review"');
    expect(html).toContain('id="item~tilde"');
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
      mockInboxWindow();
      vi.doMock('../../hooks/useInbox', () => ({
        useInbox: () => ({
          items: [base],
          counts: { question: 1, review: 0, 'plan-approval': 0 },
          total: 1,
          snoozedCount: 0,
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
      mockInboxWindow();
      vi.doMock('../../hooks/useInbox', () => ({
        useInbox: () => ({
          items: [base],
          counts: { question: 1, review: 0, 'plan-approval': 0 },
          total: 1,
          snoozedCount: 0,
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
      mockInboxWindow();
      vi.doMock('../../hooks/useInbox', () => ({
        useInbox: () => ({
          items: [base],
          counts: { question: 1, review: 0, 'plan-approval': 0 },
          total: 1,
          snoozedCount: 0,
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
