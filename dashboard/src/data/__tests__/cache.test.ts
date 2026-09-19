import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../client';
import { LOADING_SNAPSHOT, ResourceStore } from '../cache';
import { resources } from '../resources';
import { STORE_TIMERS, createFakeFetch, createFakeSource, flush } from './fakeFetch';

function setup(options: { source?: ReturnType<typeof createFakeSource>; ignoreAbort?: boolean } = {}) {
  const fake = createFakeFetch({ ignoreAbort: options.ignoreAbort });
  const store = new ResourceStore({
    client: createApiClient(fake.fetchImpl),
    source: options.source?.source ?? null,
    isVisible: () => true,
  });
  return { fake, store };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ResourceStore', () => {
  it('shares one in-flight GET between two subscribers of the same key', async () => {
    const { fake, store } = setup();
    const board = resources.tickets();
    const a = vi.fn();
    const b = vi.fn();
    const offA = store.subscribe(board, a);
    const offB = store.subscribe(resources.tickets(), b); // equivalent descriptor
    expect(fake.callsTo('/api/tickets')).toHaveLength(1);
    fake.last().respond({ tickets: [], generatedAt: 'g' });
    await flush();
    expect(store.getSnapshot(board.url).data).toEqual({ tickets: [], generatedAt: 'g' });
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
    offA();
    offB();
  });

  it('keeps the request alive when one of two consumers leaves; the last one aborts it', async () => {
    const { fake, store } = setup();
    const r = resources.ticket('T-1');
    const offA = store.subscribe(r, () => {});
    const offB = store.subscribe(r, () => {});
    const call = fake.last();
    offA();
    expect(call.signal?.aborted).toBe(false);
    offB();
    expect(call.signal?.aborted).toBe(true);
    // An aborted load leaves nothing cached; the key is stale and reloads on return.
    expect(store.getSnapshot(r.url)).toBe(LOADING_SNAPSHOT);
    const off = store.subscribe(r, () => {});
    expect(fake.callsTo(r.url)).toHaveLength(2);
    off();
  });

  it('never lets a late older response overwrite a newer load of the same key', async () => {
    const { fake, store } = setup();
    const r = resources.ticket('T-1');
    const off = store.subscribe(r, () => {});
    const first = fake.last();
    fake.last().respond({ id: 'T-1', v: 1 });
    await flush();
    store.refetch(r.url);
    const second = fake.last();
    expect(second).not.toBe(first);
    store.write(r, { id: 'T-1', v: 3 } as never); // an authoritative write supersedes the in-flight GET
    second.respond({ id: 'T-1', v: 2 });
    await flush();
    expect(store.getSnapshot<{ v: number }>(r.url).data?.v).toBe(3);
    off();
  });

  it('drops answers from superseded generations even when the transport ignores abort', async () => {
    const { fake, store } = setup({ ignoreAbort: true });
    const r = resources.ticket('T-1');
    const off = store.subscribe(r, () => {});
    const first = fake.last();
    off(); // last consumer leaves: generation invalidated
    const again = store.subscribe(r, () => {});
    const second = fake.last();
    expect(second).not.toBe(first);
    second.respond({ id: 'T-1', v: 'new' });
    await flush();
    first.respond({ id: 'T-1', v: 'old' }); // races in after the newer load
    await flush();
    expect(store.getSnapshot<{ v: string }>(r.url).data?.v).toBe('new');

    store.refetch(r.url);
    const third = fake.last();
    store.write(r, { id: 'T-1', v: 'written' } as never);
    third.respond({ id: 'T-1', v: 'stale-get' });
    await flush();
    expect(store.getSnapshot<{ v: string }>(r.url).data?.v).toBe('written');
    again();
  });

  it('keys never share data: a second ticket starts from loading, not the first ticket', async () => {
    const { fake, store } = setup();
    const off1 = store.subscribe(resources.ticket('T-1'), () => {});
    fake.last().respond({ id: 'T-1' });
    await flush();
    const off2 = store.subscribe(resources.ticket('T-2'), () => {});
    expect(store.getSnapshot(resources.ticket('T-2').url)).toBe(LOADING_SNAPSHOT);
    fake.callsTo('/api/tickets/T-2')[0].respond({ id: 'T-2' });
    await flush();
    expect(store.getSnapshot<{ id: string }>('/api/tickets/T-2').data?.id).toBe('T-2');
    expect(store.getSnapshot<{ id: string }>('/api/tickets/T-1').data?.id).toBe('T-1');
    off1();
    off2();
  });

  it('runs exactly one trailing refresh when invalidated (by mutation or WS) mid-flight', async () => {
    const source = createFakeSource();
    const { fake, store } = setup({ source });
    vi.useFakeTimers({ toFake: [...STORE_TIMERS] });
    const r = resources.ticket('T-1');
    const off = store.subscribe(r, () => {});
    const first = fake.last();
    // Several invalidations while the load is in flight collapse to one trailing refresh.
    store.invalidate([{ tag: 'ticket', ticketId: 'T-1' }]);
    store.invalidate([{ tag: 'board' }, { tag: 'ticket' }]);
    source.emit({ type: 'ticket-updated', ticketId: 'T-1' });
    vi.advanceTimersByTime(250);
    expect(fake.callsTo(r.url)).toHaveLength(1);
    first.respond({ id: 'T-1', v: 1 });
    await flush();
    expect(fake.callsTo(r.url)).toHaveLength(2);
    fake.last().respond({ id: 'T-1', v: 2 });
    await flush();
    expect(fake.callsTo(r.url)).toHaveLength(2);
    expect(store.getSnapshot<{ v: number }>(r.url).data?.v).toBe(2);
    off();
  });

  it('marks inactive keys stale on invalidation and refreshes them only when next subscribed', async () => {
    const source = createFakeSource();
    const { fake, store } = setup({ source });
    const keep = store.subscribe(resources.inbox(), () => {}); // keeps the socket attached
    fake.last().respond({ items: [] });
    const r = resources.projects();
    const off = store.subscribe(r, () => {});
    fake.last().respond([{ slug: 'a' }]);
    await flush();
    off();
    store.invalidate([{ tag: 'projects' }]);
    expect(fake.callsTo(r.url)).toHaveLength(1);
    expect(store.isStale(r.url)).toBe(true);
    // Still shows the cached value immediately while refreshing on resubscribe.
    const again = store.subscribe(r, () => {});
    expect(fake.callsTo(r.url)).toHaveLength(2);
    expect(store.getSnapshot(r.url)).toMatchObject({ data: [{ slug: 'a' }], refreshing: true, loading: false });
    fake.last().respond([{ slug: 'a' }, { slug: 'b' }]);
    await flush();
    again();
    keep();
  });

  it('serves a fresh inactive entry from cache without a request', async () => {
    const source = createFakeSource();
    const { fake, store } = setup({ source });
    const keep = store.subscribe(resources.inbox(), () => {});
    fake.last().respond({ items: [] });
    const off = store.subscribe(resources.projects(), () => {});
    fake.last().respond([]);
    await flush();
    off();
    const again = store.subscribe(resources.projects(), () => {});
    expect(fake.callsTo('/api/projects')).toHaveLength(1);
    again();
    keep();
  });

  it('keeps the same key’s last good data next to a failed refresh, and surfaces 404s', async () => {
    const { fake, store } = setup();
    const r = resources.ticket('T-1');
    const off = store.subscribe(r, () => {});
    fake.last().respond({ id: 'T-1' });
    await flush();
    store.refetch(r.url);
    fake.last().respond({ error: 'boom' }, 500);
    await flush();
    const snap = store.getSnapshot<{ id: string }>(r.url);
    expect(snap.data).toEqual({ id: 'T-1' });
    expect(snap.error?.status).toBe(500);
    expect(snap.error?.message).toBe('boom');

    const missing = resources.ticket('NOPE-1');
    const off404 = store.subscribe(missing, () => {});
    fake.last().respond({ error: 'Ticket not found' }, 404);
    await flush();
    expect(store.getSnapshot(missing.url)).toMatchObject({ data: undefined, loading: false });
    expect(store.getSnapshot(missing.url).error?.status).toBe(404);
    off();
    off404();
  });

  it('does not retry on its own after a failure', async () => {
    const { fake, store } = setup();
    vi.useFakeTimers({ toFake: [...STORE_TIMERS] });
    const off = store.subscribe(resources.projects(), () => {});
    fake.last().respond({ error: 'down' }, 503);
    await flush();
    vi.advanceTimersByTime(60_000);
    expect(fake.calls).toHaveLength(1);
    off();
  });

  it('attaches the websocket with the first subscription and detaches after the last', async () => {
    const source = createFakeSource();
    const { store } = setup({ source });
    expect(source.attached).toBe(false);
    const a = store.subscribe(resources.projects(), () => {});
    const b = store.subscribe(resources.tickets(), () => {});
    expect(source.attachCount).toBe(1);
    a();
    b();
    // Same-tick resubscribe (StrictMode / route swap) keeps the socket.
    const c = store.subscribe(resources.projects(), () => {});
    await flush();
    expect(source.attached).toBe(true);
    expect(source.attachCount).toBe(1);
    c();
    await flush();
    expect(source.attached).toBe(false);
    // While detached nothing is observable: cached entries become stale.
    expect(store.isStale('/api/tickets')).toBe(true);
  });

  it('the initial connected frame causes no extra GET; a reconnect refreshes each active key once', async () => {
    const source = createFakeSource();
    const { fake, store } = setup({ source });
    vi.useFakeTimers({ toFake: [...STORE_TIMERS] });
    const offA = store.subscribe(resources.projects(), () => {});
    const offB = store.subscribe(resources.ticket('T-1'), () => {});
    const offB2 = store.subscribe(resources.ticket('T-1'), () => {});
    fake.callsTo('/api/projects')[0].respond([]);
    fake.callsTo('/api/tickets/T-1')[0].respond({ id: 'T-1' });
    await flush();
    const inactive = store.subscribe(resources.playbooks(), () => {});
    fake.last().respond({ playbooks: [] });
    await flush();
    inactive();

    source.emit({ type: 'connected' });
    vi.advanceTimersByTime(1000);
    expect(fake.calls).toHaveLength(3);

    source.reconnect();
    expect(fake.callsTo('/api/projects')).toHaveLength(2);
    expect(fake.callsTo('/api/tickets/T-1')).toHaveLength(2);
    expect(fake.callsTo('/api/playbooks')).toHaveLength(1); // inactive: stale, not fetched
    expect(store.isStale('/api/playbooks')).toBe(true);
    offA();
    offB();
    offB2();
  });

  it('coalesces a websocket burst into one refresh per active key and scopes by ticket id', async () => {
    const source = createFakeSource();
    const { fake, store } = setup({ source });
    vi.useFakeTimers({ toFake: [...STORE_TIMERS] });
    const offs = [
      store.subscribe(resources.tickets(), () => {}),
      store.subscribe(resources.ticket('T-1'), () => {}),
      store.subscribe(resources.ticket('T-2'), () => {}),
    ];
    for (const call of [...fake.calls]) call.respond({});
    await flush();
    for (let i = 0; i < 20; i += 1) source.emit({ type: 'ticket-updated', ticketId: 'T-1', projectSlug: 'p' });
    vi.advanceTimersByTime(249);
    expect(fake.calls).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(fake.callsTo('/api/tickets')).toHaveLength(2);
    expect(fake.callsTo('/api/tickets/T-1')).toHaveLength(2);
    expect(fake.callsTo('/api/tickets/T-2')).toHaveLength(1);
    offs.forEach((off) => off());
  });

  it('coalesces session-DB notifications over a longer window (no per-turn board storm)', async () => {
    const source = createFakeSource();
    const { fake, store } = setup({ source });
    vi.useFakeTimers({ toFake: [...STORE_TIMERS] });
    const off = store.subscribe(resources.tickets(), () => {});
    fake.last().respond({ tickets: [] });
    await flush();
    for (let i = 0; i < 30; i += 1) {
      source.emit({ type: 'agent-sessions-updated' });
      vi.advanceTimersByTime(50);
    }
    // 1.5 s of chat-turn notifications: still inside the 2 s window.
    expect(fake.callsTo('/api/tickets')).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(fake.callsTo('/api/tickets')).toHaveLength(2);
    off();
  });

  it('shares one 30 s refresh timer per sessions key while active sessions exist', async () => {
    const { fake, store } = setup();
    vi.useFakeTimers({ toFake: [...STORE_TIMERS] });
    const r = resources.sessions({ pageSize: 10, page: 0 });
    const offA = store.subscribe(r, () => {});
    const offB = store.subscribe(r, () => {});
    fake.last().respond({ sessions: [{ status: 'active' }] });
    await flush();
    vi.advanceTimersByTime(30_000);
    expect(fake.callsTo(r.url)).toHaveLength(2);
    fake.last().respond({ sessions: [{ status: 'stopped' }] });
    await flush();
    vi.advanceTimersByTime(120_000);
    expect(fake.callsTo(r.url)).toHaveLength(2); // no live rows → timer stopped
    offA();
    offB();
  });

  it('expires inactive entries after five minutes', async () => {
    const { fake, store } = setup();
    vi.useFakeTimers({ toFake: [...STORE_TIMERS] });
    const off = store.subscribe(resources.templates(), () => {});
    fake.last().respond({ templates: [] });
    await flush();
    off();
    vi.advanceTimersByTime(5 * 60 * 1000 - 1);
    expect(store.hasEntry('/api/ticket-templates')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(store.hasEntry('/api/ticket-templates')).toBe(false);
  });

  it('never reuses a non-retained (editor document) entry across mounts', async () => {
    const { fake, store } = setup();
    const doc = resources.document('/api/tickets/T-1/plan/edit');
    const off = store.subscribe(doc, () => {});
    fake.last().respond({ content: 'v1' });
    await flush();
    off();
    expect(store.hasEntry(doc.url)).toBe(false);
    const again = store.subscribe(doc, () => {});
    expect(store.getSnapshot(doc.url)).toBe(LOADING_SNAPSHOT);
    expect(fake.callsTo(doc.url)).toHaveLength(2);
    again();
  });

  it('read() joins the in-flight GET and resolves fresh data without a request', async () => {
    const { fake, store } = setup();
    const off = store.subscribe(resources.templates(), () => {});
    const p = store.read(resources.templates());
    expect(fake.calls).toHaveLength(1);
    fake.last().respond({ templates: [] });
    await expect(p).resolves.toEqual({ templates: [] });
    await expect(store.read(resources.templates())).resolves.toEqual({ templates: [] });
    expect(fake.calls).toHaveLength(1);
    off();
  });

  it('refetch() resolves after the trailing reload when called mid-flight', async () => {
    const { fake, store } = setup();
    const r = resources.agents();
    const off = store.subscribe(r, () => {});
    let done = false;
    const p = store.refetch(r.url).then(() => {
      done = true;
    });
    fake.last().respond({ agents: [], errors: [] });
    await flush();
    expect(done).toBe(false);
    expect(fake.calls).toHaveLength(2);
    fake.last().respond({ agents: [{ id: 'a' }], errors: [] });
    await p;
    expect(done).toBe(true);
    off();
  });

  it('dispose releases requests, timers and the socket, and the store stays usable', async () => {
    const source = createFakeSource();
    const { fake, store } = setup({ source });
    vi.useFakeTimers({ toFake: [...STORE_TIMERS] });
    const r = resources.sessions({});
    store.subscribe(r, () => {});
    const call = fake.last();
    source.emit({ type: 'agent-sessions-updated' });
    store.dispose();
    expect(call.signal?.aborted).toBe(true);
    expect(source.attached).toBe(false);
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(fake.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    const off = store.subscribe(r, () => {});
    expect(fake.calls).toHaveLength(2);
    off();
  });

  it('SSR: seeded snapshots render without subscribing, fetching or timers', () => {
    const fake = createFakeFetch();
    const store = new ResourceStore({
      client: createApiClient(fake.fetchImpl),
      seed: [[resources.inbox(), { items: [], total: 0 }]],
    });
    const snap = store.getSnapshot(resources.inbox().url);
    expect(snap).toMatchObject({ data: { items: [], total: 0 }, loading: false });
    expect(store.getSnapshot(resources.inbox().url)).toBe(snap); // stable identity
    expect(store.getSnapshot('/api/unseeded')).toBe(LOADING_SNAPSHOT);
    expect(fake.calls).toHaveLength(0);
  });
});
