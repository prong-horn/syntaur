import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseStageHandoffReceipt,
  readStageDispatchReceipt,
  submitStageDispatchPost,
} from '../stage-dispatch-runtime';

describe('stage-dispatch-runtime', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('omits agentId for automatic dispatch posts', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 202,
      json: async () => ({
        requestId: 'auto~entry-1',
        entryId: 'entry-1',
        agentId: 'cursor',
        stage: 'in_progress',
        state: 'queued',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await submitStageDispatchPost({
      ticketId: 'T-1',
      entryId: 'entry-1',
      requestId: 'auto~entry-1',
      source: 'automatic',
      agentId: 'reviewer',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      entryId: 'entry-1',
      requestId: 'auto~entry-1',
      source: 'automatic',
    });
  });

  it('includes agentId for manual dispatch posts', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 202,
      json: async () => ({
        requestId: 'manual-1',
        entryId: 'entry-1',
        agentId: 'reviewer',
        stage: 'in_progress',
        state: 'queued',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await submitStageDispatchPost({
      ticketId: 'T-1',
      entryId: 'entry-1',
      requestId: 'manual-1',
      source: 'manual',
      agentId: 'reviewer',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      entryId: 'entry-1',
      requestId: 'manual-1',
      source: 'manual',
      agentId: 'reviewer',
    });
  });

  it('aborts only its own POST signal on timeout', async () => {
    vi.useFakeTimers();
    let postSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      postSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        postSignal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const postPromise = submitStageDispatchPost({
      ticketId: 'T-1',
      entryId: 'entry-1',
      requestId: 'auto~entry-1',
      source: 'automatic',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(postPromise).resolves.toMatchObject({ timedOut: true });
    expect(postSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('rejects malformed receipt bodies from status reads', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ state: 'bogus' }), { status: 200 }));
    await expect(
      readStageDispatchReceipt('T-1', 'manual-1', undefined, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow('Malformed dispatch receipt');
  });

  it('returns null for an unknown receipt (404)', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 404 }));
    await expect(
      readStageDispatchReceipt('T-1', 'manual-1', undefined, fetchImpl as unknown as typeof fetch),
    ).resolves.toBeNull();
  });
});

describe('parseStageHandoffReceipt', () => {
  it('accepts a well-formed receipt and drops unknown fields', () => {
    expect(
      parseStageHandoffReceipt({
        requestId: 'r',
        entryId: 'e',
        agentId: 'a',
        stage: 's',
        state: 'failed',
        error: 'boom',
        extra: 1,
      }),
    ).toEqual({ requestId: 'r', entryId: 'e', agentId: 'a', stage: 's', state: 'failed', error: 'boom' });
  });

  it('rejects null, non-objects, and unknown states', () => {
    expect(parseStageHandoffReceipt(null)).toBeNull();
    expect(parseStageHandoffReceipt('queued')).toBeNull();
    expect(
      parseStageHandoffReceipt({ requestId: 'r', entryId: 'e', agentId: 'a', stage: 's', state: 'done' }),
    ).toBeNull();
  });
});
