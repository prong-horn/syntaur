import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { InboxItem } from '../../lib/inbox';
import { ResourceProvider } from '../../data/useResource';
import { resources } from '../../data/resources';
import { NeedsMePage } from '../NeedsMePage';

const base: InboxItem = {
  project: 'demo',
  ticketSlug: 'task',
  ticketId: 'uuid-1',
  title: 'Needs me',
  category: 'question',
  since: '2026-06-16T00:00:00Z',
  ageMs: 60_000,
  summary: 'Which name?',
  questionTs: '2026-06-16T00:00:00Z',
  journalTab: 'file:journal.md',
  action: {
    verb: 'Answer',
    command: 'syntaur log task -t answer --answers 2026-06-16T00:00:00Z "<answer>" --project demo',
  },
  ticketUpdated: '',
};

function inboxSeed(
  items: InboxItem[],
  extra: { total?: number; snoozedCount?: number } = {},
) {
  return [
    [
      resources.inbox({ project: null, maxAgeDays: 14, includeSnoozed: false }),
      {
        items,
        counts: { question: items.length, review: 0, 'plan-approval': 0 },
        total: extra.total ?? items.length,
        snoozedCount: extra.snoozedCount ?? 0,
      },
    ],
    [resources.projects(), [{ slug: 'demo', title: 'Demo' }, { slug: 'alpha', title: 'Alpha' }]],
    [resources.agents(), { agents: [], errors: [] }],
    [resources.harnesses(), { harnesses: [] }],
  ] as const;
}

function renderNeedsMe(seed: ReturnType<typeof inboxSeed>, path = '/inbox') {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <ResourceProvider seed={[...seed]}>
        <NeedsMePage />
      </ResourceProvider>
    </MemoryRouter>,
  );
}

describe('NeedsMePage', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('renders a flat list without section headings or CLI code lines', () => {
    const html = renderNeedsMe(
      inboxSeed([
        { ...base, category: 'review', acceptCommand: 'done', reopenCommand: 'start' },
        base,
      ]),
    );
    expect(html).not.toContain('<code');
    expect(html).not.toContain('Questions');
    expect(html).not.toContain('Review');
    expect(html).toContain('Needs me');
    expect(html).toContain('2 waiting');
    expect(html).toContain('Last 14 days');
    expect(html).toContain('aria-pressed="true"');
  });

  it('renders the project select with slugs from the projects resource', () => {
    const html = renderNeedsMe(inboxSeed([base]));
    expect(html).toContain('All projects');
    expect(html).toContain('alpha');
    expect(html).toContain('demo');
  });

  it('renders the empty state describing inbox sources', () => {
    const html = renderNeedsMe(inboxSeed([], { total: 0 }));
    expect(html).toContain('Nothing in the last 14 days');
    expect(html).toContain('plan approvals');
  });

  it('renders the 14-day empty state by default', () => {
    const html = renderNeedsMe(inboxSeed([], { total: 0 }));
    expect(html).toContain('Nothing in the last 14 days');
    expect(html).toContain('Show all');
  });

  it('renders Snoozed foot when snoozedCount is positive', () => {
    const html = renderNeedsMe(inboxSeed([], { total: 0, snoozedCount: 2 }));
    expect(html).toContain('Snoozed (2)');
  });

  it('renders anchor ids on list rows', () => {
    const html = renderNeedsMe(
      inboxSeed([
        { ...base, category: 'review', acceptCommand: 'done', reopenCommand: 'start' },
        { ...base, chat: { kind: 'reply', itemId: 'item~tilde', agentId: 'claude' } },
      ]),
    );
    expect(html).toContain('id="uuid-1~review"');
    expect(html).toContain('id="uuid-1~20260616T000000Z"');
  });
});

describe('NeedsMePage export', () => {
  it('exports NeedsMePage', async () => {
    const mod = await import('../NeedsMePage');
    expect(mod.NeedsMePage).toBeDefined();
  });
});
