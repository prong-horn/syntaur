/**
 * Central write path. Every dashboard mutation goes through {@link mutate}:
 * it sends through the store's client (so tests inject one transport), returns
 * the server's actual response, and invalidates the explicitly declared
 * resource families.
 *
 * - Success (any 2xx, including 204 → `undefined`): invalidate, return the body.
 *   A lifecycle 200 whose stage dispatch failed or is unknown is still a
 *   successful move — the caller surfaces its warnings; reads still refresh.
 * - Refusal (4xx): nothing changed server-side; rethrow the {@link ApiError}
 *   with its body (`next`, warnings) intact; no invalidation.
 * - Uncertain failure (network, 5xx, malformed 2xx): the write may or may not
 *   have landed, so the relevant reads are invalidated — the write itself is
 *   NEVER retried — and the error is rethrown.
 */
import { isApiError } from './client';
import { getDefaultResourceStore, type ResourceStore } from './cache';
import type { InvalidationTarget } from './resources';

export type MutationMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface MutateOptions {
  invalidates?: readonly InvalidationTarget[];
  /** Defaults to the browser store. */
  store?: ResourceStore;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

function isRawBody(body: unknown): body is BodyInit {
  return (
    typeof body === 'string' ||
    (typeof FormData !== 'undefined' && body instanceof FormData) ||
    (typeof Blob !== 'undefined' && body instanceof Blob) ||
    (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  );
}

export async function mutate<T = unknown>(
  method: MutationMethod,
  url: string,
  body?: unknown,
  options: MutateOptions = {},
): Promise<T> {
  const store = options.store ?? getDefaultResourceStore();
  const invalidates = options.invalidates ?? [];
  let result: T;
  try {
    result = await store.client.requestJson<T>(url, {
      method,
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(body === undefined ? {} : isRawBody(body) ? { body } : { json: body }),
    });
  } catch (err) {
    if (!isApiError(err) || err.uncertain) store.invalidate(invalidates);
    throw err;
  }
  store.invalidate(invalidates);
  return result;
}
