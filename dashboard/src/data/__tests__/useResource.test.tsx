import { StrictMode, useState } from 'react';
import { renderToString } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../client';
import { ResourceStore, __resetDefaultResourceStoreForTests, getDefaultResourceStore } from '../cache';
import { resources, type Resource } from '../resources';
import { ResourceProvider, useResource } from '../useResource';
import { useTicket } from '../../hooks/useProjects';
import { useInbox } from '../../hooks/useInbox';
import { useContentSearch } from '../../hooks/useContentSearch';
import { saveSearchConfig, useSearchConfig } from '../../hooks/useSearchConfig';
import { useTicketEvents } from '../../hooks/useTicketEvents';
import { STORE_TIMERS, createFakeFetch, createFakeSource, flush } from './fakeFetch';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  __resetDefaultResourceStoreForTests();
});

function makeStore(source?: ReturnType<typeof createFakeSource>) {
  const fake = createFakeFetch();
  const store = new ResourceStore({
    client: createApiClient(fake.fetchImpl),
    source: source?.source ?? null,
    isVisible: () => true,
  });
  return { fake, store };
}

function Show<T>({ resource, label = 'r' }: { resource: Resource<T> | null; label?: string }) {
  const { data, loading, error, refreshing } = useResource(resource);
  return (
    <span data-label={label}>
      {loading ? 'loading' : error ? `error:${error.status}:${error.message}` : data === undefined ? 'none' : JSON.stringify(data)}
      {refreshing ? ' (refreshing)' : ''}
    </span>
  );
}

function text(renderer: TestRenderer.ReactTestRenderer): string {
  const json = renderer.toJSON();
  const collect = (node: unknown): string => {
    if (node === null || node === undefined) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(collect).join('|');
    const n = node as { children?: unknown[] };
    return (n.children ?? []).map(collect).join('');
  };
  return collect(json);
}

async function settle(fn: () => void = () => {}) {
  await act(async () => {
    fn();
    await flush();
  });
}

describe('useResource mounted under a real provider', () => {
  it('StrictMode: two consumers of one key end with exactly one live GET and share the result', async () => {
    const { fake, store } = makeStore();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <StrictMode>
          <ResourceProvider store={store}>
            <Show resource={resources.projects()} label="a" />
            <Show resource={resources.projects()} label="b" />
          </ResourceProvider>
        </StrictMode>,
      );
    });
    const live = fake.callsTo('/api/projects').filter((c) => !c.signal?.aborted);
    expect(live).toHaveLength(1);
    expect(text(renderer)).toBe('loading|loading');
    await settle(() => live[0].respond([{ slug: 'p' }]));
    expect(text(renderer)).toBe('[{"slug":"p"}]|[{"slug":"p"}]');
    await act(async () => renderer.unmount());
    expect(store.subscriptionCount).toBe(0);
  });

  it('re-rendering with an equivalent descriptor does not resubscribe or refetch', async () => {
    const { fake, store } = makeStore();
    function Rerenders() {
      const [n, setN] = useState(0);
      const { data } = useResource(resources.ticket('T-1'));
      return (
        <button type="button" onClick={() => setN(n + 1)}>
          {n}:{data ? 'x' : '-'}
        </button>
      );
    }
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ResourceProvider store={store}>
          <Rerenders />
        </ResourceProvider>,
      );
    });
    await settle(() => fake.last().respond({ id: 'T-1' }));
    for (let i = 0; i < 3; i += 1) {
      await settle(() => renderer.root.findByType('button').props.onClick());
    }
    expect(fake.callsTo('/api/tickets/T-1')).toHaveLength(1);
    expect(text(renderer)).toBe('3:x');
    renderer.unmount();
  });

  it('switching ticket ids never shows the previous ticket and aborts its pending load', async () => {
    const { fake, store } = makeStore();
    function Ticket({ id }: { id: string }) {
      const { data, loading } = useTicket(id);
      return <span>{loading ? 'loading' : data ? (data as unknown as { id: string }).id : 'none'}</span>;
    }
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ResourceProvider store={store}>
          <Ticket id="T-1" />
        </ResourceProvider>,
      );
    });
    await settle(() => fake.last().respond({ id: 'T-1' }));
    expect(text(renderer)).toBe('T-1');

    await settle(() =>
      renderer.update(
        <ResourceProvider store={store}>
          <Ticket id="T-2" />
        </ResourceProvider>,
      ),
    );
    expect(text(renderer)).toBe('loading');
    const t2 = fake.last('/api/tickets/T-2');

    await settle(() =>
      renderer.update(
        <ResourceProvider store={store}>
          <Ticket id="T-3" />
        </ResourceProvider>,
      ),
    );
    expect(t2.signal?.aborted).toBe(true);
    // A late answer for T-2 changes nothing on T-3.
    t2.respond({ id: 'T-2' });
    await settle();
    expect(text(renderer)).toBe('loading');
    await settle(() => fake.last('/api/tickets/T-3').respond({ id: 'T-3' }));
    expect(text(renderer)).toBe('T-3');
    renderer.unmount();
  });

  it('legacy wrappers expose a visible 404 as an error string', async () => {
    const { fake, store } = makeStore();
    function Ticket() {
      const { error, loading } = useTicket('GONE-1');
      return <span>{loading ? 'loading' : error ?? 'ok'}</span>;
    }
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ResourceProvider store={store}>
          <Ticket />
        </ResourceProvider>,
      );
    });
    await settle(() => fake.last().respond({ error: 'Ticket "GONE-1" not found' }, 404));
    expect(text(renderer)).toBe('Ticket "GONE-1" not found');
    renderer.unmount();
  });

  it('a null resource makes no request and is not loading', async () => {
    const { fake, store } = makeStore();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ResourceProvider store={store}>
          <Show resource={null} />
        </ResourceProvider>,
      );
    });
    expect(fake.calls).toHaveLength(0);
    expect(text(renderer)).toBe('none');
    expect(store.subscriptionCount).toBe(0);
    renderer.unmount();
  });

  it('unmounting the last consumer aborts the in-flight request', async () => {
    const { fake, store } = makeStore();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ResourceProvider store={store}>
          <Show resource={resources.overview()} />
        </ResourceProvider>,
      );
    });
    const call = fake.last();
    await act(async () => renderer.unmount());
    expect(call.signal?.aborted).toBe(true);
  });

  it('the Needs-me page and the shell badge share one inbox request', async () => {
    const { fake, store } = makeStore();
    function Badge() {
      const { total } = useInbox({ maxAgeDays: 7 });
      return <b>{total}</b>;
    }
    function Page() {
      const { items, loading } = useInbox({ maxAgeDays: 7 });
      return <i>{loading ? 'loading' : items.length}</i>;
    }
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <StrictMode>
          <ResourceProvider store={store}>
            <Badge />
            <Page />
          </ResourceProvider>
        </StrictMode>,
      );
    });
    const live = fake.calls.filter((c) => !c.signal?.aborted);
    expect(live.map((c) => c.url)).toEqual(['/api/inbox?maxAgeDays=7']);
    await settle(() => live[0].respond({ items: [{ key: 'a' }], counts: {}, total: 1, snoozedCount: 0 }));
    expect(text(renderer)).toBe('1|1');
    renderer.unmount();
  });

  it('refreshes live on a scoped websocket invalidation without blanking data', async () => {
    const source = createFakeSource();
    const { fake, store } = makeStore(source);
    vi.useFakeTimers({ toFake: [...STORE_TIMERS] });
    function Events() {
      const { events } = useTicketEvents('T-1');
      return <span>{events.length}</span>;
    }
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ResourceProvider store={store}>
          <Events />
          <Show resource={resources.ticketEvents('T-2')} label="other" />
        </ResourceProvider>,
      );
    });
    await settle(() => {
      fake.last('/api/tickets/T-1/events').respond({ events: [{}] });
      fake.last('/api/tickets/T-2/events').respond({ events: [] });
    });
    expect(text(renderer)).toBe('1|{"events":[]}');
    await settle(() => {
      source.emit({ type: 'ticket-updated', ticketId: 'T-1', projectSlug: 'p' });
      vi.advanceTimersByTime(250);
    });
    expect(fake.callsTo('/api/tickets/T-1/events')).toHaveLength(2);
    expect(fake.callsTo('/api/tickets/T-2/events')).toHaveLength(1);
    expect(text(renderer)).toBe('1|{"events":[]}'); // same-key data kept while refreshing
    await settle(() => fake.last('/api/tickets/T-1/events').respond({ events: [{}, {}] }));
    expect(text(renderer)).toBe('2|{"events":[]}');
    renderer.unmount();
  });

  it('a reconnect refetches each mounted key once; the first connection does not', async () => {
    const source = createFakeSource();
    const { fake, store } = makeStore(source);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <StrictMode>
          <ResourceProvider store={store}>
            <Show resource={resources.tickets()} label="a" />
            <Show resource={resources.tickets()} label="b" />
            <Show resource={resources.playbooks()} label="c" />
          </ResourceProvider>
        </StrictMode>,
      );
    });
    await settle(() => {
      for (const c of fake.pending()) c.respond({});
    });
    const before = fake.calls.filter((c) => !c.signal?.aborted).length;
    await settle(() => source.emit({ type: 'connected' }));
    expect(fake.calls.filter((c) => !c.signal?.aborted).length).toBe(before);
    await settle(() => source.reconnect());
    expect(fake.calls.filter((c) => !c.signal?.aborted).length).toBe(before + 2);
    renderer.unmount();
  });

  it('rapid search typing only requests the settled query and never shows stale hits', async () => {
    const { fake, store } = makeStore();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    function Search({ q }: { q: string }) {
      const { hits, loading } = useContentSearch(q, true);
      return <span>{loading ? 'loading' : hits.map((h) => h.title).join(',') || 'empty'}</span>;
    }
    const tree = (q: string) => (
      <ResourceProvider store={store}>
        <Search q={q} />
      </ResourceProvider>
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(tree('pl'));
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    const plCall = fake.last();
    expect(plCall.url).toBe('/api/search?q=pl');
    for (const q of ['pla', 'plan', 'plann']) {
      await act(async () => {
        renderer.update(tree(q));
        vi.advanceTimersByTime(50);
      });
    }
    expect(fake.calls).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(fake.calls.map((c) => c.url)).toEqual(['/api/search?q=pl', '/api/search?q=plann']);
    expect(plCall.signal?.aborted).toBe(true);
    expect(text(renderer)).toBe('loading');
    // The older answer arriving late is ignored.
    await settle(() => plCall.respond({ hits: [{ title: 'OLD' }] }));
    expect(text(renderer)).toBe('loading');
    await settle(() => fake.last().respond({ hits: [{ title: 'NEW' }] }));
    expect(text(renderer)).toBe('NEW');
    renderer.unmount();
  });

  it('an owned provider releases its store (socket, requests) on unmount', async () => {
    const source = createFakeSource();
    const fake = createFakeFetch();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <StrictMode>
          <ResourceProvider client={createApiClient(fake.fetchImpl)} source={source.source}>
            <Show resource={resources.projects()} />
          </ResourceProvider>
        </StrictMode>,
      );
    });
    expect(source.attached).toBe(true);
    const live = fake.calls.filter((c) => !c.signal?.aborted);
    expect(live).toHaveLength(1);
    await act(async () => renderer.unmount());
    await flush();
    expect(source.attached).toBe(false);
    expect(live[0].signal?.aborted).toBe(true);
  });

  it('two isolated providers do not share cache entries', async () => {
    const one = makeStore();
    const two = makeStore();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <>
          <ResourceProvider store={one.store}>
            <Show resource={resources.projects()} />
          </ResourceProvider>
          <ResourceProvider store={two.store}>
            <Show resource={resources.projects()} />
          </ResourceProvider>
        </>,
      );
    });
    expect(one.fake.calls).toHaveLength(1);
    expect(two.fake.calls).toHaveLength(1);
    await settle(() => one.fake.last().respond(['one']));
    expect(text(renderer)).toBe('["one"]|loading');
    renderer.unmount();
  });

  it('a settings save propagates to every mounted consumer of the config resource', async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method });
        if (init?.method === 'POST') {
          return new Response(JSON.stringify({ search: { defaultScope: 'content', aliases: {} }, custom: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ search: { defaultScope: 'tickets', aliases: {} }, custom: false }), { status: 200 });
      }),
    );
    function Scope() {
      const config = useSearchConfig();
      return <span>{`${config.search.defaultScope}:${config.custom}`}</span>;
    }
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ResourceProvider store={getDefaultResourceStore()}>
          <Scope />
          <Scope />
        </ResourceProvider>,
      );
    });
    await settle();
    await settle(() => {
      void saveSearchConfig({ defaultScope: 'content', aliases: {} } as never);
    });
    const gets = calls.filter((c) => !c.method);
    expect(gets).toHaveLength(1);
    expect(text(renderer)).toContain('true');
    expect(text(renderer).split('|')[0]).toBe(text(renderer).split('|')[1]);
    renderer.unmount();
  });
});

describe('useResource SSR', () => {
  it('renders seeded data with no fetch, socket or timers; unseeded keys render loading', () => {
    const source = createFakeSource();
    const fake = createFakeFetch();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const html = renderToString(
      <ResourceProvider
        client={createApiClient(fake.fetchImpl)}
        source={source.source}
        seed={[[resources.ticket('T-1'), { id: 'T-1', title: 'Seeded' }]]}
      >
        <Show resource={resources.ticket('T-1')} />
        <Show resource={resources.ticket('T-2')} />
      </ResourceProvider>,
    );
    expect(html).toContain('Seeded');
    expect(html).toContain('loading');
    expect(fake.calls).toHaveLength(0);
    expect(source.attachCount).toBe(0);
    expect(timers).not.toHaveBeenCalled();
    timers.mockRestore();
  });
});
