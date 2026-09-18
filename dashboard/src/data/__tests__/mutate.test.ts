import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, createApiClient } from '../client';
import { ResourceStore, __resetDefaultResourceStoreForTests } from '../cache';
import { mutate } from '../mutate';
import { resources, ticketWriteTargets } from '../resources';
import { createFakeFetch, flush } from './fakeFetch';

function setup() {
  const fake = createFakeFetch();
  const store = new ResourceStore({ client: createApiClient(fake.fetchImpl) });
  return { fake, store };
}

async function primeTicket(fake: ReturnType<typeof createFakeFetch>, store: ResourceStore) {
  const off = store.subscribe(resources.ticket('T-1'), () => {});
  fake.last().respond({ id: 'T-1' });
  await flush();
  return off;
}

afterEach(() => {
  __resetDefaultResourceStoreForTests();
});

describe('mutate', () => {
  it('returns the actual response and invalidates the declared families on success', async () => {
    const { fake, store } = setup();
    const off = await primeTicket(fake, store);
    const p = mutate('POST', '/api/tickets/T-1/verbs/start', { agent: 'codex' }, {
      store,
      invalidates: ticketWriteTargets('T-1'),
    });
    const body = { ticket: { id: 'T-1' }, next: null, dispatch: { state: 'failed', error: 'offline' }, warnings: ['w'] };
    fake.last().respond(body);
    // A 200 with a failed dispatch is still a successful move: result returned, reads refresh.
    await expect(p).resolves.toEqual(body);
    expect(fake.callsTo('/api/tickets/T-1')).toHaveLength(2);
    expect(JSON.parse(fake.callsTo('/api/tickets/T-1/verbs/start')[0].init!.body as string)).toEqual({ agent: 'codex' });
    off();
  });

  it('handles 204 as undefined and still invalidates', async () => {
    const { fake, store } = setup();
    const off = await primeTicket(fake, store);
    const p = mutate('DELETE', '/api/tickets/T-1', undefined, { store, invalidates: ticketWriteTargets('T-1') });
    fake.last().respond(undefined, 204);
    await expect(p).resolves.toBeUndefined();
    const gets = fake.callsTo('/api/tickets/T-1').filter((c) => !c.init?.method);
    expect(gets).toHaveLength(2);
    off();
  });

  it('rethrows a structured refusal with next/warnings and does not invalidate', async () => {
    const { fake, store } = setup();
    const off = await primeTicket(fake, store);
    const p = mutate('POST', '/api/tickets/T-1/verbs/review', {}, { store, invalidates: ticketWriteTargets('T-1') });
    fake.last().respond({ error: 'plan not approved', next: 'syntaur approve T-1', warnings: ['x'] }, 409);
    const err = (await p.catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.next).toBe('syntaur approve T-1');
    expect((err.body as { warnings: string[] }).warnings).toEqual(['x']);
    expect(fake.callsTo('/api/tickets/T-1')).toHaveLength(1);
    off();
  });

  it('on an uncertain failure invalidates the reads without retrying the write', async () => {
    const { fake, store } = setup();
    const off = await primeTicket(fake, store);
    const p = mutate('POST', '/api/tickets/T-1/log', { body: 'x' }, { store, invalidates: ticketWriteTargets('T-1') });
    fake.last().fail(new TypeError('network down'));
    await expect(p).rejects.toMatchObject({ kind: 'network' });
    expect(fake.callsTo('/api/tickets/T-1/log')).toHaveLength(1);
    expect(fake.callsTo('/api/tickets/T-1')).toHaveLength(2);
    off();
  });

  it('sends FormData/Blob bodies raw', async () => {
    const { fake, store } = setup();
    const form = new FormData();
    const p = mutate('POST', '/api/upload', form, { store });
    fake.last().respond({});
    await p;
    expect(fake.last().init!.body).toBe(form);
    expect(fake.last().init!.headers).toBeUndefined();
  });
});

describe('domain mutations delegate to mutate', () => {
  it('runTicketVerb appends Next to the message but keeps the ApiError body', async () => {
    const { vi } = await import('vitest');
    const { runTicketVerb } = await import('../../lib/tickets');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'refused', next: 'do X', warnings: ['w'] }), { status: 409 })),
    );
    try {
      const err = (await runTicketVerb('T-1', 'review').catch((e: unknown) => e)) as ApiError;
      expect(err).toBeInstanceOf(ApiError);
      expect(err.message).toBe('refused — Next: do X');
      expect(err.status).toBe(409);
      expect(err.next).toBe('do X');
      expect((err.body as { warnings: string[] }).warnings).toEqual(['w']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('createTicketWorktree keeps git stderr on its error', async () => {
    const { vi } = await import('vitest');
    const { createTicketWorktree, CreateWorktreeError } = await import('../../lib/tickets');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'git failed', stderr: 'fatal: bad ref' }), { status: 400 })),
    );
    try {
      const err = (await createTicketWorktree('T-1', { repository: '/r' }).catch((e: unknown) => e)) as InstanceType<
        typeof CreateWorktreeError
      >;
      expect(err).toBeInstanceOf(CreateWorktreeError);
      expect(err.message).toBe('git failed');
      expect(err.stderr).toBe('fatal: bad ref');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
