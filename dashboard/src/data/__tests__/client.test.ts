import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, isApiError } from '../client';
import { createFakeFetch } from './fakeFetch';

describe('data/client requestJson', () => {
  it('parses JSON and passes method, signal and a JSON body with content type', async () => {
    const fake = createFakeFetch();
    const client = createApiClient(fake.fetchImpl);
    const controller = new AbortController();
    const p = client.requestJson<{ ok: boolean }>('/api/x', { method: 'POST', json: { a: 1 }, signal: controller.signal });
    fake.last().respond({ ok: true });
    await expect(p).resolves.toEqual({ ok: true });
    const init = fake.last().init!;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init.signal).toBe(controller.signal);
  });

  it('keeps caller headers and does not add a content type to FormData', async () => {
    const fake = createFakeFetch();
    const client = createApiClient(fake.fetchImpl);
    const form = new FormData();
    form.set('k', 'v');
    const p = client.requestJson('/api/form', { method: 'POST', body: form, headers: { 'x-a': '1' } });
    fake.last().respond({});
    await p;
    expect(fake.last().init!.headers).toEqual({ 'x-a': '1' });
    expect(fake.last().init!.body).toBe(form);

    const q = client.requestJson('/api/json', { method: 'PUT', json: {}, headers: { 'content-type': 'application/merge+json' } });
    fake.last().respond({});
    await q;
    expect(fake.last().init!.headers).toEqual({ 'content-type': 'application/merge+json' });
  });

  it('returns undefined for 204 and for an empty 200 body', async () => {
    const fake = createFakeFetch();
    const client = createApiClient(fake.fetchImpl);
    const a = client.requestJson('/api/a', { method: 'DELETE' });
    fake.last().respond(undefined, 204);
    await expect(a).resolves.toBeUndefined();
    const b = client.requestJson('/api/b');
    fake.last().respondRaw('', 200);
    await expect(b).resolves.toBeUndefined();
  });

  it('throws an ApiError that preserves status, body, next and dispatch warnings', async () => {
    const fake = createFakeFetch();
    const client = createApiClient(fake.fetchImpl);
    const p = client.requestJson('/api/tickets/T-1/verbs/start', { method: 'POST', json: {} });
    const body = { error: 'gate refused', next: 'syntaur plan T-1', warnings: ['w1'], dispatch: { state: 'failed' } };
    fake.last().respond(body, 409);
    const err = await p.catch((e: unknown) => e);
    expect(isApiError(err)).toBe(true);
    const apiErr = err as ApiError;
    expect(apiErr.message).toBe('gate refused');
    expect(apiErr.status).toBe(409);
    expect(apiErr.kind).toBe('http');
    expect(apiErr.body).toEqual(body);
    expect(apiErr.next).toBe('syntaur plan T-1');
    expect(apiErr.uncertain).toBe(false);
  });

  it('joins validation `errors` and falls back to HTTP <status> for non-JSON errors', async () => {
    const fake = createFakeFetch();
    const client = createApiClient(fake.fetchImpl);
    const a = client.requestJson('/api/config/search', { method: 'POST', json: {} });
    fake.last().respond({ errors: ['bad alias', 'bad scope'] }, 400);
    await expect(a).rejects.toThrow('bad alias; bad scope');
    const b = client.requestJson('/api/x');
    fake.last().respondRaw('<html>oops</html>', 502);
    const err = (await b.catch((e: unknown) => e)) as ApiError;
    expect(err.message).toBe('HTTP 502');
    expect(err.uncertain).toBe(true);
  });

  it('reports a malformed 2xx as uncertain instead of fabricating success or refusal', async () => {
    const fake = createFakeFetch();
    const client = createApiClient(fake.fetchImpl);
    const p = client.requestJson('/api/x', { method: 'POST', json: {} });
    fake.last().respondRaw('{not json', 200);
    const err = (await p.catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe('malformed');
    expect(err.uncertain).toBe(true);
  });

  it('wraps transport failures as network ApiErrors but rethrows aborts untouched', async () => {
    const fake = createFakeFetch();
    const client = createApiClient(fake.fetchImpl);
    const p = client.requestJson('/api/x');
    fake.last().fail(new TypeError('Failed to fetch'));
    const err = (await p.catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe('network');
    expect(err.status).toBe(0);
    expect(err.uncertain).toBe(true);

    const controller = new AbortController();
    const q = client.requestJson('/api/y', { signal: controller.signal });
    controller.abort();
    const aborted = (await q.catch((e: unknown) => e)) as Error;
    expect(aborted.name).toBe('AbortError');
    expect(isApiError(aborted)).toBe(false);
  });

  it('requestResponse is a raw passthrough (status and unread body preserved)', async () => {
    const fake = createFakeFetch();
    const client = createApiClient(fake.fetchImpl);
    const init = { method: 'POST', body: '{"x":1}', headers: { 'Content-Type': 'application/json' } };
    const p = client.requestResponse('/api/tickets/T-1/dispatch', init);
    fake.last().respondRaw('not-json', 202);
    const response = await p;
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('not-json');
    expect(fake.last().init).toBe(init);
  });

  it('requestResponse propagates transport errors unchanged (SV-11 unknown path)', async () => {
    const fake = createFakeFetch();
    const client = createApiClient(fake.fetchImpl);
    const p = client.requestResponse('/api/x');
    const boom = new TypeError('socket hang up');
    fake.last().fail(boom);
    await expect(p).rejects.toBe(boom);
  });

  it('uploads binary bodies with caller headers and octet-stream default', async () => {
    const fake = createFakeFetch();
    const client = createApiClient(fake.fetchImpl);
    const blob = new Blob(['abc'], { type: 'image/png' });
    const p = client.uploadBinary<{ id: string }>('/api/tickets/T-1/chat/attachments', blob, {
      headers: { 'x-attachment-mime': 'image/png' },
    });
    fake.last().respond({ id: 'a1' }, 201);
    await expect(p).resolves.toEqual({ id: 'a1' });
    expect(fake.last().init!.method).toBe('POST');
    expect(fake.last().init!.body).toBe(blob);
    expect(fake.last().init!.headers).toEqual({
      'Content-Type': 'application/octet-stream',
      'x-attachment-mime': 'image/png',
    });
  });

  it('the default client resolves the global fetch lazily (vi.stubGlobal still reaches it)', async () => {
    const { requestJson } = await import('../client');
    const stub = vi.fn(async () => new Response('{"v":2}', { status: 200 }));
    vi.stubGlobal('fetch', stub);
    try {
      await expect(requestJson('/api/lazy')).resolves.toEqual({ v: 2 });
      expect(stub).toHaveBeenCalledWith('/api/lazy', {});
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
