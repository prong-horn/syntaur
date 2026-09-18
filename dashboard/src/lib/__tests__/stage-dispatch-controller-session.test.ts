import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageHandoffDescriptor, StageHandoffReceiptSummary } from '../../hooks/useProjects';
import { StageDispatchController } from '../stage-dispatch-controller';

const POLL_MS = 2000;
const POST_TIMEOUT_MS = 15_000;

function descriptorFor(overrides: Partial<StageHandoffDescriptor> = {}): StageHandoffDescriptor {
  return {
    entryId: 'entry-1',
    stage: 'in_progress',
    role: 'agent',
    defaultAgentId: 'cursor',
    startDefaultAgentId: 'cursor',
    startDefaultAuto: true,
    auto: true,
    templateAuto: true,
    recordedTargetId: 'cursor',
    canDispatch: true,
    manualFallback: false,
    ...overrides,
  };
}

function receipt(
  requestId: string,
  state: StageHandoffReceiptSummary['state'],
  entryId = 'entry-1',
): StageHandoffReceiptSummary {
  return { requestId, entryId, agentId: 'cursor', stage: 'in_progress', state };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type Call = { url: string; init?: RequestInit; body?: Record<string, unknown> };

/** Scripted fetch: each handler answers one request in order. */
function scriptedFetch(
  ...handlers: Array<(url: string, init?: RequestInit) => Promise<Response> | Response>
) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      init,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const handler = handlers.shift();
    if (!handler) throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${url}`);
    return handler(url, init);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function hangUntilAbort(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
}

function makeController(fetchImpl: typeof fetch, uuids: string[] = []) {
  const refetch = vi.fn();
  const controller = new StageDispatchController({
    ticketId: 'T-1',
    onTicketRefetch: refetch,
    fetchImpl,
    mintUuid: () => {
      const next = uuids.shift();
      if (!next) throw new Error('unexpected uuid mint');
      return next;
    },
    pollMs: POLL_MS,
    postTimeoutMs: POST_TIMEOUT_MS,
  });
  controller.start();
  return { controller, refetch };
}

describe('StageDispatchController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends one request for two same-tick handOff clicks', async () => {
    const post = deferred<Response>();
    const { fetchImpl, calls } = scriptedFetch(() => post.promise);
    const { controller } = makeController(fetchImpl);
    controller.sync(descriptorFor());

    const first = controller.handOff();
    const second = controller.handOff();
    expect(controller.getState().busy).toBe(true);
    await second;
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({
      entryId: 'entry-1',
      requestId: 'auto~entry-1',
      source: 'automatic',
    });

    post.resolve(json(receipt('auto~entry-1', 'queued'), 202));
    await first;
    expect(calls).toHaveLength(1);
    expect(controller.getState()).toMatchObject({
      busy: false,
      clientState: 'queued',
      activeRequestId: 'auto~entry-1',
    });
    controller.stop();
  });

  it('recovers a timed-out POST by polling the same id with a live signal, then cancels', async () => {
    const { fetchImpl, calls } = scriptedFetch(
      hangUntilAbort,
      () => json(receipt('auto~entry-1', 'queued')),
      () => json({ ok: true }),
      () => json(receipt('auto~entry-1', 'cancelled')),
    );
    const { controller, refetch } = makeController(fetchImpl);
    controller.sync(descriptorFor());

    const handOff = controller.handOff();
    await vi.advanceTimersByTimeAsync(POST_TIMEOUT_MS);
    await handOff;
    expect(calls[0].init?.signal?.aborted).toBe(true);
    expect(controller.getState()).toMatchObject({
      clientState: 'unknown',
      activeRequestId: 'auto~entry-1',
      busy: false,
    });

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(calls[1].url).toBe('/api/tickets/T-1/dispatch/auto~entry-1');
    expect(calls[1].init?.signal?.aborted).toBe(false);
    expect(controller.getState().clientState).toBe('queued');

    await controller.cancel();
    expect(calls[2].url).toBe('/api/tickets/T-1/dispatch/auto~entry-1/cancel');
    expect(calls[2].init?.method).toBe('POST');
    expect(calls[2].init?.signal?.aborted).toBe(false);
    expect(controller.getState().clientState).toBe('cancelled');
    expect(refetch).toHaveBeenCalled();

    // Terminal: polling stopped.
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(calls).toHaveLength(4);
    controller.stop();
  });

  it('keeps the stable id through unknown retry after a timeout', async () => {
    const { fetchImpl, calls } = scriptedFetch(hangUntilAbort, () =>
      json(receipt('manual-1', 'queued'), 202),
    );
    const { controller } = makeController(fetchImpl, ['manual-1']);
    controller.sync(descriptorFor({ auto: false }));

    const handOff = controller.handOff();
    await vi.advanceTimersByTimeAsync(POST_TIMEOUT_MS);
    await handOff;
    expect(controller.getState().clientState).toBe('unknown');

    await controller.handOff(); // refused while unknown
    await controller.retry();
    expect(calls).toHaveLength(2);
    expect(calls[1].body?.requestId).toBe('manual-1');
    expect(controller.getState().clientState).toBe('queued');
    controller.stop();
  });

  it('resets on a new stage entry: next handOff is auto~<new entry>, not a manual id', async () => {
    const { fetchImpl, calls } = scriptedFetch(
      () => json(receipt('manual-1', 'queued'), 202),
      () => json(receipt('manual-1', 'completed')),
      () => json(receipt('auto~entry-2', 'queued', 'entry-2'), 202),
    );
    const { controller } = makeController(fetchImpl, ['manual-1']);
    controller.sync(descriptorFor({ auto: false }));
    controller.setSelectedAgentId('reviewer');

    await controller.handOff();
    expect(calls[0].body).toMatchObject({ requestId: 'manual-1', source: 'manual', agentId: 'reviewer' });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(controller.getState().clientState).toBe('completed');

    // Agent moved the ticket to a new automatic stage entry.
    controller.sync(descriptorFor({ entryId: 'entry-2', stage: 'review' }));
    expect(controller.getState()).toMatchObject({
      clientState: 'idle',
      activeRequestId: null,
      receipt: null,
      selectedAgentId: null,
    });
    expect(controller.primarySource()).toBe('automatic');

    await controller.handOff();
    expect(calls[2].body).toEqual({
      entryId: 'entry-2',
      requestId: 'auto~entry-2',
      source: 'automatic',
    });
    expect(controller.getState().activeRequestId).toBe('auto~entry-2');
    controller.stop();
  });

  it('adopts a new active server receipt after a terminal local one and blocks retry', async () => {
    const { fetchImpl, calls } = scriptedFetch(() => json(receipt('manual-1', 'completed'), 202));
    const { controller } = makeController(fetchImpl, ['manual-1']);
    controller.sync(descriptorFor({ auto: false }));
    await controller.handOff();
    expect(controller.getState().clientState).toBe('completed');

    // Same entry, but another tab/CLI started a new request that is running.
    controller.sync(
      descriptorFor({
        auto: false,
        canDispatch: false,
        reason: 'Handoff running (other-1)',
        latestReceipt: receipt('other-1', 'running'),
      }),
    );
    expect(controller.getState()).toMatchObject({
      clientState: 'running',
      activeRequestId: 'other-1',
    });

    await controller.retry();
    await controller.handOff();
    expect(calls).toHaveLength(1);
    expect(controller.primarySource()).toBe('manual');
    controller.stop();
  });

  it('polls the adopted server request id', async () => {
    const { fetchImpl, calls } = scriptedFetch(() => json(receipt('other-1', 'completed')));
    const { controller, refetch } = makeController(fetchImpl);
    controller.sync(descriptorFor({ canDispatch: false, latestReceipt: receipt('other-1', 'running') }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(calls[0].url).toBe('/api/tickets/T-1/dispatch/other-1');
    expect(controller.getState().clientState).toBe('completed');
    expect(refetch).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it('ignores a stale POST result that resolves after a new stage entry', async () => {
    const oldPost = deferred<Response>();
    const { fetchImpl, calls } = scriptedFetch(
      () => oldPost.promise,
      () => json(receipt('auto~entry-2', 'queued', 'entry-2'), 202),
    );
    const { controller } = makeController(fetchImpl);
    controller.sync(descriptorFor());

    const pending = controller.handOff();
    controller.sync(descriptorFor({ entryId: 'entry-2', stage: 'review' }));
    expect(controller.getState().busy).toBe(true); // old action still owns the guard

    oldPost.resolve(json(receipt('auto~entry-1', 'queued'), 202));
    await pending;
    expect(controller.getState()).toMatchObject({
      descriptorEntryId: 'entry-2',
      clientState: 'idle',
      activeRequestId: null,
      receipt: null,
      busy: false,
    });

    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(calls).toHaveLength(1); // nothing polled for the stale request

    await controller.handOff();
    expect(calls[1].body?.requestId).toBe('auto~entry-2');
    controller.stop();
  });

  it('ignores a stale poll result that resolves after a new stage entry', async () => {
    const poll = deferred<Response>();
    const { fetchImpl } = scriptedFetch(() => poll.promise);
    const { controller } = makeController(fetchImpl);
    controller.sync(descriptorFor({ canDispatch: false, latestReceipt: receipt('auto~entry-1', 'running') }));

    await vi.advanceTimersByTimeAsync(POLL_MS);
    controller.sync(descriptorFor({ entryId: 'entry-2', stage: 'review' }));
    poll.resolve(json(receipt('auto~entry-1', 'completed')));
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getState()).toMatchObject({
      clientState: 'idle',
      activeRequestId: null,
      receipt: null,
    });
    controller.stop();
  });

  it('treats a malformed 2xx body as unknown with the stable id', async () => {
    const { fetchImpl, calls } = scriptedFetch(
      () => new Response('not json', { status: 202 }),
      () => json(receipt('manual-1', 'queued')),
    );
    const { controller, refetch } = makeController(fetchImpl, ['manual-1']);
    controller.sync(descriptorFor({ auto: false }));

    await controller.handOff();
    expect(controller.getState()).toMatchObject({
      clientState: 'unknown',
      activeRequestId: 'manual-1',
      busy: false,
      errorMessage: null,
    });
    expect(refetch).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(calls[1].url).toBe('/api/tickets/T-1/dispatch/manual-1');
    expect(controller.getState().clientState).toBe('queued');
    controller.stop();
  });

  it('treats a network failure as unknown with the stable id', async () => {
    const { fetchImpl } = scriptedFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const { controller } = makeController(fetchImpl);
    controller.sync(descriptorFor());
    await controller.handOff();
    expect(controller.getState()).toMatchObject({
      clientState: 'unknown',
      activeRequestId: 'auto~entry-1',
    });
    controller.stop();
  });

  it('surfaces a stale-entry 409 inline and refetches without throwing', async () => {
    const { fetchImpl } = scriptedFetch(() => json({ error: 'Stale stage entry' }, 409));
    const { controller, refetch } = makeController(fetchImpl);
    controller.sync(descriptorFor());
    await expect(controller.handOff()).resolves.toBeUndefined();
    expect(controller.getState()).toMatchObject({
      staleMessage: 'Stale stage entry',
      clientState: 'idle',
      busy: false,
    });
    expect(refetch).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it('refuses a new-id retry when the server descriptor cannot dispatch', async () => {
    const { fetchImpl, calls } = scriptedFetch(() => json(receipt('manual-1', 'completed'), 202));
    const { controller } = makeController(fetchImpl, ['manual-1']);
    controller.sync(descriptorFor({ auto: false }));
    await controller.handOff();

    controller.sync(
      descriptorFor({
        auto: false,
        canDispatch: false,
        reason: 'Agent @cursor is disabled',
        latestReceipt: receipt('manual-1', 'completed'),
      }),
    );
    await controller.retry();
    expect(calls).toHaveLength(1);
    expect(controller.getState().errorMessage).toBe('Agent @cursor is disabled');
    controller.stop();
  });

  it('requires an agent for a manual request and clears the one-use selection on acceptance', async () => {
    const { fetchImpl, calls } = scriptedFetch(() => json(receipt('manual-1', 'queued'), 202));
    const { controller } = makeController(fetchImpl, ['manual-1']);
    controller.sync(descriptorFor({ auto: false, defaultAgentId: null, role: null }));

    await controller.handOff();
    expect(calls).toHaveLength(0);
    expect(controller.getState().errorMessage).toBe('Select an agent to hand off work');

    controller.setSelectedAgentId('reviewer');
    await controller.handOff();
    expect(calls[0].body).toMatchObject({ source: 'manual', agentId: 'reviewer' });
    expect(controller.getState().selectedAgentId).toBeNull();
    controller.stop();
  });

  it('recovers an override entry on an auto:false stage with auto~entry and no agentId', async () => {
    const { fetchImpl, calls } = scriptedFetch(() =>
      json({ ...receipt('auto~entry-1', 'queued'), agentId: 'codex' }, 202),
    );
    // No uuids: minting a manual id would throw.
    const { controller } = makeController(fetchImpl);
    controller.sync(
      descriptorFor({ auto: true, templateAuto: false, recordedTargetId: 'codex' }),
    );
    expect(controller.primarySource()).toBe('automatic');

    await controller.handOff();
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({
      entryId: 'entry-1',
      requestId: 'auto~entry-1',
      source: 'automatic',
    });
    expect(controller.getState().receipt?.agentId).toBe('codex');
    controller.stop();
  });

  it('sends a manual request to the template default on a non-auto entry', async () => {
    const { fetchImpl, calls } = scriptedFetch(() => json(receipt('manual-1', 'queued'), 202));
    const { controller } = makeController(fetchImpl, ['manual-1']);
    controller.sync(descriptorFor({ auto: false, templateAuto: false }));
    expect(controller.primarySource()).toBe('manual');

    await controller.handOff();
    expect(calls[0].body).toEqual({
      entryId: 'entry-1',
      requestId: 'manual-1',
      source: 'manual',
      agentId: 'cursor',
    });
    controller.stop();
  });

  it('keeps fallback entries manual even when the template stage is auto', async () => {
    const entryId = 'unrecorded~in_progress~abc';
    const { fetchImpl, calls } = scriptedFetch(() =>
      json({ ...receipt('manual-1', 'queued'), entryId }, 202),
    );
    const { controller } = makeController(fetchImpl, ['manual-1']);
    controller.sync(
      descriptorFor({
        entryId,
        manualFallback: true,
        auto: false,
        templateAuto: true,
        recordedTargetId: null,
      }),
    );
    expect(controller.primarySource()).toBe('manual');

    await controller.handOff();
    expect(calls[0].body).toMatchObject({ source: 'manual', requestId: 'manual-1', agentId: 'cursor' });
    controller.stop();
  });

  it('refetches on websocket frames for other requests without polling them', async () => {
    const { fetchImpl, calls } = scriptedFetch(() => json(receipt('manual-1', 'running')));
    const { controller, refetch } = makeController(fetchImpl);
    controller.sync(descriptorFor({ canDispatch: false, latestReceipt: receipt('manual-1', 'queued') }));

    controller.handleFrame({ ticketId: 'T-2', requestId: 'manual-1' });
    expect(refetch).not.toHaveBeenCalled();

    controller.handleFrame({ ticketId: 'T-1', requestId: 'auto~entry-2' });
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);

    controller.handleFrame({ ticketId: 'T-1', requestId: 'manual-1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(controller.getState().clientState).toBe('running');
    controller.stop();
  });

  it('stop() aborts polling and ignores late results', async () => {
    const poll = deferred<Response>();
    const { fetchImpl, calls } = scriptedFetch(() => poll.promise);
    const { controller } = makeController(fetchImpl);
    controller.sync(descriptorFor({ canDispatch: false, latestReceipt: receipt('auto~entry-1', 'queued') }));

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(calls).toHaveLength(1);
    controller.stop();
    expect(calls[0].init?.signal?.aborted).toBe(true);
    poll.resolve(json(receipt('auto~entry-1', 'completed')));
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(calls).toHaveLength(1);
    expect(controller.getState().clientState).toBe('queued');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resumes polling after a StrictMode-style stop/start', async () => {
    const { fetchImpl, calls } = scriptedFetch(() => json(receipt('auto~entry-1', 'running')));
    const { controller } = makeController(fetchImpl);
    controller.sync(descriptorFor({ canDispatch: false, latestReceipt: receipt('auto~entry-1', 'queued') }));
    controller.stop();
    controller.start();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.signal?.aborted).toBe(false);
    expect(controller.getState().clientState).toBe('running');
    controller.stop();
  });
});
