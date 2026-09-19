import { MemoryRouter } from 'react-router-dom';
import { renderToString } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../data/client';
import { ResourceStore, __resetDefaultResourceStoreForTests } from '../../data/cache';
import { ResourceProvider } from '../../data/useResource';
import { SessionsPage } from '../SessionsPage';
import { createFakeFetch, flush } from '../../data/__tests__/fakeFetch';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  __resetDefaultResourceStoreForTests();
});

function makeStore() {
  const fake = createFakeFetch();
  const store = new ResourceStore({
    client: createApiClient(fake.fetchImpl),
    source: null,
    isVisible: () => true,
  });
  return { fake, store };
}

const emptySessions = {
  sessions: [],
  page: { page: 0, pageSize: 100, pageCount: 1, totalCount: 0, attributionCounts: {} },
};

describe('SessionsPage', () => {
  it('SSR renders without fetch/socket', () => {
    const { store } = makeStore();
    const html = renderToString(
      <ResourceProvider store={store}>
        <MemoryRouter initialEntries={['/sessions']}>
          <SessionsPage />
        </MemoryRouter>
      </ResourceProvider>,
    );
    expect(html).toContain('Sessions');
    expect(store.subscriptionCount).toBe(0);
  });

  it('loads sessions from seeded GET and shows filter-driven URL', async () => {
    vi.useFakeTimers();
    const { fake, store } = makeStore();
    await act(async () => {
      TestRenderer.create(
        <ResourceProvider store={store}>
          <MemoryRouter initialEntries={['/sessions?sessionSearch=codex&sessionPage=1']}>
            <SessionsPage />
          </MemoryRouter>
        </ResourceProvider>,
      );
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
      await flush();
    });
    const calls = fake.calls.filter((c) => c.url.startsWith('/api/agent-sessions') && c.url.includes('search=codex'));
    expect(calls.length).toBeGreaterThan(0);
    await act(async () => {
      for (const call of calls) call.respond(emptySessions);
      await flush();
    });
    expect(
      fake.calls.some((c) => c.url.startsWith('/api/agent-sessions') && (c.url.includes('page=1') || c.url.includes('page=2'))),
    ).toBe(true);
    vi.useRealTimers();
  });

  it('usage panel uses namespaced resource key with groupBy', async () => {
    vi.useFakeTimers();
    const { fake, store } = makeStore();
    await act(async () => {
      TestRenderer.create(
        <ResourceProvider store={store}>
          <MemoryRouter initialEntries={['/sessions?panel=usage&usageWindow=7d&usageGroupBy=ticket']}>
            <SessionsPage />
          </MemoryRouter>
        </ResourceProvider>,
      );
      vi.advanceTimersByTime(300);
      await flush();
    });
    const usageCall = fake.calls.find((c) => c.url.startsWith('/api/usage') && c.url.includes('groupBy=ticket'));
    expect(usageCall).toBeTruthy();
    const sessionsCall = fake.calls.find((c) => c.url.startsWith('/api/agent-sessions'));
    expect(sessionsCall).toBeTruthy();
    vi.useRealTimers();
  });
});
