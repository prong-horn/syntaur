/**
 * Controllable fetch double for data-layer tests: every call is recorded with
 * its AbortSignal and stays pending until the test resolves it, so ordering
 * races (late old responses, aborts, trailing refreshes) are deterministic.
 */
import type { FetchLike } from '../client';
import type { InvalidationSource } from '../cache';
import type { WsMessage } from '../../hooks/wsManager';

export interface PendingCall {
  url: string;
  init: RequestInit | undefined;
  signal: AbortSignal | undefined;
  settled: boolean;
  respond(body: unknown, status?: number): void;
  respondRaw(text: string, status?: number): void;
  fail(error: Error): void;
}

/** `ignoreAbort`: model a server answer that races past the abort (the store must still drop it). */
export function createFakeFetch(options: { ignoreAbort?: boolean } = {}) {
  const calls: PendingCall[] = [];
  const fetchImpl: FetchLike = (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal ?? undefined;
      const call: PendingCall = {
        url,
        init,
        signal,
        settled: false,
        respond(body, status = 200) {
          this.respondRaw(body === undefined ? '' : JSON.stringify(body), status);
        },
        respondRaw(text, status = 200) {
          if (call.settled) return;
          call.settled = true;
          resolve(new Response(status === 204 ? null : text, { status }));
        },
        fail(error) {
          if (call.settled) return;
          call.settled = true;
          reject(error);
        },
      };
      if (!options.ignoreAbort) signal?.addEventListener('abort', () => {
        if (call.settled) return;
        call.settled = true;
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
      calls.push(call);
    });
  return {
    fetchImpl,
    calls,
    callsTo(url: string) {
      return calls.filter((c) => c.url === url);
    },
    pending() {
      return calls.filter((c) => !c.settled);
    },
    last(url?: string) {
      const list = url ? calls.filter((c) => c.url === url) : calls;
      return list[list.length - 1];
    },
  };
}

/** Websocket stand-in with explicit message/reconnect triggers and attach counts. */
export function createFakeSource() {
  const messageListeners = new Set<(m: WsMessage) => void>();
  const reconnectListeners = new Set<() => void>();
  let attaches = 0;
  const source: InvalidationSource = {
    subscribeMessages(listener) {
      attaches += 1;
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    subscribeReconnect(listener) {
      reconnectListeners.add(listener);
      return () => reconnectListeners.delete(listener);
    },
  };
  return {
    source,
    emit(message: Partial<WsMessage> & { type: WsMessage['type'] }) {
      for (const l of [...messageListeners]) l({ timestamp: 't', ...message } as WsMessage);
    },
    reconnect() {
      for (const l of [...reconnectListeners]) l();
    },
    get attached() {
      return messageListeners.size > 0;
    },
    get attachCount() {
      return attaches;
    },
  };
}

// Captured before any test installs fake timers.
const realSetImmediate = globalThis.setImmediate;

/** Let promise continuations (fetch → body stream → store) run to quiescence. */
export async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>((resolve) => realSetImmediate(resolve));
  }
}

/** Fake only the timer APIs the store schedules; keep setImmediate/microtasks real. */
export const STORE_TIMERS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] as const;
