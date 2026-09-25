import { MemoryRouter } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { activeSidebarProjectSlug, ticketIdFromPathname } from '../SidebarProjects';
import { ResourceProvider } from '../../data/useResource';
import { resources } from '../../data/resources';
import { createApiClient } from '../../data/client';
import { ResourceStore, __resetDefaultResourceStoreForTests } from '../../data/cache';
import type { ProjectSummary, TicketDetail } from '../../data/types';
import { createFakeFetch, flush } from '../../data/__tests__/fakeFetch';
import { AppShell } from '../AppShell';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

function makeProject(
  overrides: Partial<ProjectSummary> & { slug: string; title: string },
): ProjectSummary {
  return {
    status: 'active',
    statusOverride: null,
    archived: false,
    archivedAt: null,
    archivedReason: null,
    created: '2026-01-01T00:00:00Z',
    updated: '2026-01-01T00:00:00Z',
    tags: [],
    externalIds: [],
    progress: { total: 0, done: 0, dropped: 0 },
    needsAttention: { blockedCount: 0, failedCount: 0, openQuestions: 0 },
    ...overrides,
  };
}

type SidebarProjectsComponent = typeof import('../SidebarProjects').SidebarProjects;

async function loadSidebarProjects(): Promise<SidebarProjectsComponent> {
  const mod = await import('../SidebarProjects');
  return mod.SidebarProjects;
}

function renderProjects(
  SidebarProjects: SidebarProjectsComponent,
  path: string,
  projects: ProjectSummary[],
  extraSeed: Array<readonly [ReturnType<typeof resources.ticket>, TicketDetail]> = [],
) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <ResourceProvider
        seed={[
          [resources.projects(), projects],
          ...extraSeed,
        ]}
      >
        <SidebarProjects />
      </ResourceProvider>
    </MemoryRouter>,
  );
}

vi.mock('../../hooks/useInbox', () => ({
  useInbox: () => ({ total: 0, items: [], loading: false, error: null }),
}));
vi.mock('../../hooks/useInboxWindow', () => ({
  useInboxWindow: () => ({ maxAgeDays: 14 }),
}));
vi.mock('../../hooks/useChatAgents', () => ({
  useChatAgents: () => ({ data: { agents: [] } }),
}));
vi.mock('../../hooks/useInboxNotifications', () => ({
  useInboxNotifications: () => {},
}));
vi.mock('../TopBar', () => ({
  TopBar: () => null,
}));

const collapseStorage = new Map<string, string>();

beforeAll(() => {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => collapseStorage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      collapseStorage.set(key, value);
    },
    removeItem: (key: string) => {
      collapseStorage.delete(key);
    },
    clear: () => collapseStorage.clear(),
  });
});

describe('ticketIdFromPathname', () => {
  it('returns the decoded id on a ticket page', () => {
    expect(ticketIdFromPathname('/t/SYN-230')).toBe('SYN-230');
    expect(ticketIdFromPathname('/t/PJ%2D1/chat')).toBe('PJ-1');
  });

  it('returns undefined off ticket pages and for malformed encoding', () => {
    expect(ticketIdFromPathname('/board')).toBeUndefined();
    expect(ticketIdFromPathname('/t/%E0%A4%A')).toBeUndefined();
  });
});

describe('activeSidebarProjectSlug', () => {
  it('returns the slug for /board?project=x', () => {
    expect(activeSidebarProjectSlug('/board', '?project=demo')).toBe('demo');
  });

  it('returns none for ?project= (cleared)', () => {
    expect(activeSidebarProjectSlug('/board', '?project=')).toBeUndefined();
  });

  it('returns none for legacy ?project=a,b', () => {
    expect(activeSidebarProjectSlug('/board', '?project=a,b')).toBeUndefined();
  });

  it('returns none for ?project=a&project=b', () => {
    expect(activeSidebarProjectSlug('/board', '?project=a&project=b')).toBeUndefined();
  });

  it('works with a /board/ trailing slash', () => {
    expect(activeSidebarProjectSlug('/board/', '?project=demo')).toBe('demo');
  });
});

describe('SidebarProjects', () => {
  afterEach(() => {
    __resetDefaultResourceStoreForTests();
    collapseStorage.clear();
  });

  it('renders active projects sorted by title', async () => {
    const SidebarProjects = await loadSidebarProjects();
    const html = renderProjects(SidebarProjects, '/inbox', [
      makeProject({ slug: 'zeta', title: 'Zeta' }),
      makeProject({ slug: 'alpha', title: 'alpha' }),
      makeProject({ slug: 'beta', title: 'Beta' }),
    ]);
    const alphaPos = html.indexOf('alpha');
    const betaPos = html.indexOf('Beta');
    const zetaPos = html.indexOf('Zeta');
    expect(alphaPos).toBeGreaterThan(-1);
    expect(betaPos).toBeGreaterThan(alphaPos);
    expect(zetaPos).toBeGreaterThan(betaPos);
  });

  it('excludes archived projects from the list', async () => {
    const SidebarProjects = await loadSidebarProjects();
    const html = renderProjects(SidebarProjects, '/inbox', [
      makeProject({ slug: 'live', title: 'Live' }),
      makeProject({ slug: 'gone', title: 'Gone', archived: true }),
    ]);
    expect(html).toContain('Live');
    expect(html).not.toContain('Gone');
  });

  it('links to /board?project= with encoded slugs', async () => {
    const SidebarProjects = await loadSidebarProjects();
    const html = renderProjects(SidebarProjects, '/inbox', [
      makeProject({ slug: 'needs encode', title: 'Needs Encode' }),
    ]);
    expect(html).toContain('/board?project=needs%20encode');
  });

  it('shows open ticket count as total minus done minus dropped and hides zero', async () => {
    const SidebarProjects = await loadSidebarProjects();
    const html = renderProjects(SidebarProjects, '/inbox', [
      makeProject({
        slug: 'busy',
        title: 'Busy',
        progress: { total: 10, done: 3, dropped: 2, open: 5 },
      }),
      makeProject({
        slug: 'quiet',
        title: 'Quiet',
        progress: { total: 2, done: 2, dropped: 0 },
      }),
    ]);
    expect(html).toContain('>5<');
    expect(html).not.toMatch(/Quiet[\s\S]*>0</);
  });

  it('highlights the row for /board?project=x when exactly one project param', async () => {
    const SidebarProjects = await loadSidebarProjects();
    const html = renderProjects(SidebarProjects, '/board?project=demo', [
      makeProject({ slug: 'demo', title: 'Demo' }),
      makeProject({ slug: 'other', title: 'Other' }),
    ]);
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('Demo');
  });

  it('does not highlight any row when board has no project filter', async () => {
    const SidebarProjects = await loadSidebarProjects();
    const html = renderProjects(SidebarProjects, '/board', [
      makeProject({ slug: 'demo', title: 'Demo' }),
    ]);
    expect(html).not.toContain('aria-current="page"');
  });

  it('does not highlight any row when board has two project params', async () => {
    const SidebarProjects = await loadSidebarProjects();
    const html = renderProjects(SidebarProjects, '/board?project=a&project=b', [
      makeProject({ slug: 'a', title: 'A' }),
      makeProject({ slug: 'b', title: 'B' }),
    ]);
    expect(html).not.toContain('aria-current="page"');
  });

  it('highlights the ticket project on a ticket page', async () => {
    const SidebarProjects = await loadSidebarProjects();
    const ticket: TicketDetail = {
      id: 'T-1',
      slug: 'task',
      title: 'Task',
      status: 'open',
      template: null,
      statusLabel: 'Open',
      priority: 'medium',
      assignee: null,
      depends_on: [],
      links: [],
      reverseLinks: [],
      enrichedLinks: [],
      blocked: null,
      parked: null,
      workspace: { repository: null, worktree: null, branch: null, parentBranch: null },
      tags: [],
      completedAt: null,
      statusAge: null,
      next: null,
      stageHandoff: {
        entryId: 'e1',
        stage: 'implement',
        role: 'agent',
        defaultAgentId: null,
        startDefaultAgentId: null,
        startDefaultAuto: true,
        auto: true,
        templateAuto: true,
        recordedTargetId: null,
        canDispatch: false,
        manualFallback: false,
      },
      created: '2026-01-01T00:00:00Z',
      updated: '2026-01-01T00:00:00Z',
      body: '',
      projectSlug: 'demo',
      availableVerbs: [],
      templateBlock: { id: 'feature', files: [] },
      engagements: [],
      referencedBy: [],
      metrics: { costUsd: 0, sessionCount: 0, costSource: 'usage', partial: false },
      plan: null,
      scratchpad: null,
    };
    const html = renderProjects(
      SidebarProjects,
      '/t/T-1',
      [
        makeProject({ slug: 'demo', title: 'Demo' }),
        makeProject({ slug: 'other', title: 'Other' }),
      ],
      [[resources.ticket('T-1'), ticket]],
    );
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('Demo');
  });

  it('hides rows when collapsed and highlights the header when a project is active', async () => {
    const SidebarProjects = await loadSidebarProjects();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MemoryRouter initialEntries={['/board?project=demo']}>
          <ResourceProvider
            seed={[[resources.projects(), [makeProject({ slug: 'demo', title: 'Demo' })]]]}
          >
            <SidebarProjects />
          </ResourceProvider>
        </MemoryRouter>,
      );
    });
    expect(JSON.stringify(renderer.toJSON())).toContain('Demo');
    const header = renderer.root
      .findAllByType('button')
      .find((node) => node.children.some((child) => typeof child === 'string' && child.includes('Projects')));
    expect(header).toBeDefined();
    await act(async () => {
      header!.props.onClick();
    });
    const collapsed = JSON.stringify(renderer.toJSON());
    expect(collapsed).not.toContain('aria-label="Projects"');
    expect(collapsed).toContain('text-foreground');
    expect(collapsed).not.toContain('Demo');
    await act(async () => {
      header!.props.onClick();
    });
    await act(async () => renderer.unmount());
  });

  it('shows a muted empty state when there are no active projects', async () => {
    const SidebarProjects = await loadSidebarProjects();
    const html = renderProjects(SidebarProjects, '/inbox', []);
    expect(html).toContain('No active projects');
  });

  it('shows a muted error line when projects fail to load', async () => {
    const fake = createFakeFetch();
    const store = new ResourceStore({
      client: createApiClient(fake.fetchImpl),
      source: null,
      isVisible: () => true,
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    const SidebarProjects = await loadSidebarProjects();
    await act(async () => {
      renderer = TestRenderer.create(
        <ResourceProvider store={store}>
          <MemoryRouter initialEntries={['/inbox']}>
            <SidebarProjects />
          </MemoryRouter>
        </ResourceProvider>,
      );
      await flush();
    });
    await act(async () => {
      fake.last().respond({ error: 'down' }, 500);
      await flush();
    });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('Projects unavailable');
    await act(async () => renderer.unmount());
  });
});

describe('AppShell sidebar', () => {
  afterEach(() => {
    __resetDefaultResourceStoreForTests();
  });

  it('shows the Projects heading after the five primary nav links', async () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/inbox']}>
        <ResourceProvider seed={[[resources.projects(), []]]}>
          <AppShell title="Inbox" breadcrumbs={[]} projectSlug={null}>
            <div>child</div>
          </AppShell>
        </ResourceProvider>
      </MemoryRouter>,
    );
    const settingsPos = html.indexOf('Settings');
    const projectsPos = html.indexOf('>Projects<');
    expect(settingsPos).toBeGreaterThan(-1);
    expect(projectsPos).toBeGreaterThan(settingsPos);
  });
});
