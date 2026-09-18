/**
 * The dashboard's single finite-resource cache (React-free; bound to React by
 * `useResource.ts`). One instance per `ResourceProvider`: the browser app uses
 * {@link getDefaultResourceStore}; tests and SSR build isolated stores.
 *
 * Contract (SV-12):
 * - The exact canonical URL is the key. One shared in-flight GET per key;
 *   subscribers are reference counted; snapshots are immutable and keep their
 *   identity until something observable changes.
 * - Fetches start from `subscribe` (a commit-phase effect), never from render.
 * - Every load claims a new generation and its own AbortController; a result
 *   from an older generation (superseded, aborted, written over) is dropped.
 *   The last subscriber leaving aborts the in-flight load; StrictMode's
 *   subscribe → unsubscribe → subscribe simply restarts it.
 * - Invalidating a key while its load is in flight marks it dirty and runs
 *   exactly ONE trailing refresh after it settles (never deduped away).
 * - Active keys refresh on invalidation; inactive keys only become stale and
 *   refresh when next subscribed. Inactive entries expire after five minutes.
 * - A failed refresh keeps the same key's last good data next to the error.
 *   Data never crosses keys.
 * - Websocket invalidations are coalesced for 250 ms (2 s for the broad
 *   session-DB notification, which every chat turn triggers). Only a reconnect after a
 *   genuine connection loss invalidates everything; the first connection does
 *   not. The source is attached by the first active subscription and detached
 *   by the last; while detached nothing can be observed, so all entries are
 *   marked stale on detach.
 * - Nothing retries on its own and mutations are never retried.
 * - SSR: rendering reads `getSnapshot` only (seeded data or a stable loading
 *   snapshot). A store with no subscriptions opens no socket, starts no timer
 *   and makes no request.
 */
import {
  ApiError,
  defaultApiClient,
  errorMessage,
  isAbortError,
  isApiError,
  type ApiClient,
} from './client';
import {
  invalidationsForMessage,
  matchesTarget,
  type InvalidationTarget,
  type Resource,
} from './resources';
import { subscribe as subscribeWs, subscribeReconnect, type WsMessage } from '../hooks/wsManager';

export interface ResourceSnapshot<T = unknown> {
  readonly data: T | undefined;
  readonly error: ApiError | null;
  /** Nothing to show yet for this key and a load is pending or in flight. */
  readonly loading: boolean;
  /** This key's data is shown while a same-key reload is in flight. */
  readonly refreshing: boolean;
  /** When `data` last came from the server (ms epoch), null before. */
  readonly updatedAt: number | null;
}

export const LOADING_SNAPSHOT: ResourceSnapshot<never> = Object.freeze({
  data: undefined,
  error: null,
  loading: true,
  refreshing: false,
  updatedAt: null,
});

export const DISABLED_SNAPSHOT: ResourceSnapshot<never> = Object.freeze({
  data: undefined,
  error: null,
  loading: false,
  refreshing: false,
  updatedAt: null,
});

/** Where websocket invalidations come from (wsManager in the browser, fakes in tests). */
export interface InvalidationSource {
  subscribeMessages(listener: (message: WsMessage) => void): () => void;
  subscribeReconnect(listener: () => void): () => void;
}

export interface ResourceStoreOptions {
  client?: ApiClient;
  /** null/omitted: no websocket invalidation (SSR, most unit tests). */
  source?: InvalidationSource | null;
  /** Pre-populated entries (SSR/tests). Seeded entries are fresh. */
  seed?: Iterable<readonly [Resource<unknown>, unknown]>;
  coalesceMs?: number;
  /** Coalescing window for broad session-DB notifications (every chat turn writes the DB). */
  sessionCoalesceMs?: number;
  inactiveTtlMs?: number;
  /** Background refresh pauses while this returns false (default: document visibility). */
  isVisible?: () => boolean;
  now?: () => number;
}

interface Waiter {
  /** Settles only with a load of at least this generation (or a write). */
  minGeneration: number;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface Entry {
  readonly url: string;
  resource: Resource<unknown>;
  snapshot: ResourceSnapshot<unknown>;
  readonly listeners: Set<() => void>;
  generation: number;
  controller: AbortController | null;
  inFlight: boolean;
  /** Invalidated while in flight → one trailing refresh after settle. */
  dirty: boolean;
  /** Must refetch before being trusted again (refreshes on next subscribe). */
  stale: boolean;
  waiters: Waiter[];
  expiryTimer: ReturnType<typeof setTimeout> | null;
  refreshTimer: ReturnType<typeof setInterval> | null;
}

const DEFAULT_COALESCE_MS = 250;
const DEFAULT_SESSION_COALESCE_MS = 2000;
const DEFAULT_INACTIVE_TTL_MS = 5 * 60 * 1000;

function defaultIsVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

function abortError(): Error {
  const err = new Error('The resource request was aborted');
  err.name = 'AbortError';
  return err;
}

function toApiError(err: unknown, url: string): ApiError {
  if (isApiError(err)) return err;
  return new ApiError({ message: errorMessage(err, 'Request failed'), status: 0, kind: 'network', url, cause: err });
}

function targetKey(target: InvalidationTarget): string {
  return `${target.tag}|${target.ticketId ?? ''}|${target.projectSlug ?? ''}|${target.configKind ?? ''}`;
}

export class ResourceStore {
  readonly client: ApiClient;
  private readonly source: InvalidationSource | null;
  private readonly entries = new Map<string, Entry>();
  private readonly coalesceMs: number;
  private readonly sessionCoalesceMs: number;
  private readonly inactiveTtlMs: number;
  private readonly isVisible: () => boolean;
  private readonly now: () => number;

  private activeSubscriptions = 0;
  private detachSource: (() => void) | null = null;
  private detachScheduled = false;
  /** One coalescing bucket per window length. */
  private readonly coalescing = new Map<number, { timer: ReturnType<typeof setTimeout>; targets: Map<string, InvalidationTarget> }>();

  constructor(options: ResourceStoreOptions = {}) {
    this.client = options.client ?? defaultApiClient;
    this.source = options.source ?? null;
    this.coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
    this.sessionCoalesceMs = options.sessionCoalesceMs ?? DEFAULT_SESSION_COALESCE_MS;
    this.inactiveTtlMs = options.inactiveTtlMs ?? DEFAULT_INACTIVE_TTL_MS;
    this.isVisible = options.isVisible ?? defaultIsVisible;
    this.now = options.now ?? Date.now;
    for (const [resource, data] of options.seed ?? []) {
      const entry = this.ensure(resource);
      entry.snapshot = Object.freeze({ data, error: null, loading: false, refreshing: false, updatedAt: this.now() });
    }
  }

  // --- React binding surface -------------------------------------------------

  /** Stable snapshot for `url` (a shared frozen loading snapshot when unknown). */
  getSnapshot<T>(url: string): ResourceSnapshot<T> {
    return (this.entries.get(url)?.snapshot ?? LOADING_SNAPSHOT) as ResourceSnapshot<T>;
  }

  subscribe(resource: Resource<unknown>, listener: () => void): () => void {
    const entry = this.ensure(resource);
    // Keep the freshest descriptor (tags/refresh policy) for this key.
    entry.resource = resource;
    if (entry.expiryTimer) {
      clearTimeout(entry.expiryTimer);
      entry.expiryTimer = null;
    }
    entry.listeners.add(listener);
    this.activeSubscriptions += 1;
    this.attachSource();
    if (entry.listeners.size === 1 && !entry.inFlight && (entry.stale || entry.snapshot.data === undefined)) {
      this.load(entry);
    }
    this.syncRefreshTimer(entry);

    let done = false;
    return () => {
      if (done) return;
      done = true;
      entry.listeners.delete(listener);
      this.activeSubscriptions -= 1;
      if (entry.listeners.size === 0) this.deactivate(entry);
      if (this.activeSubscriptions === 0) this.scheduleDetach();
    };
  }

  // --- imperative API ------------------------------------------------------

  /**
   * Reload now if anyone is watching (or trail the in-flight load); else mark
   * stale. Resolves once that reload settles (never rejects — failures land in
   * the snapshot's `error`).
   */
  refetch(url: string): Promise<void> {
    const entry = this.entries.get(url);
    if (!entry) return Promise.resolve();
    this.invalidateEntry(entry);
    if (!entry.inFlight) return Promise.resolve();
    // A dirty in-flight load is followed by exactly one trailing load; wait for it.
    const minGeneration = entry.dirty ? entry.generation + 1 : entry.generation;
    return new Promise<void>((resolve) => {
      entry.waiters.push({ minGeneration, resolve: () => resolve(), reject: () => resolve() });
    });
  }

  /** Invalidate matching entries immediately (local mutations). */
  invalidate(targets: readonly InvalidationTarget[]): void {
    if (targets.length === 0) return;
    for (const entry of this.entries.values()) {
      if (targets.some((t) => matchesTarget(entry.resource, t))) this.invalidateEntry(entry);
    }
  }

  /** Invalidate after a coalescing window (websocket bursts); defaults to 250 ms. */
  scheduleInvalidate(targets: readonly InvalidationTarget[], delayMs: number = this.coalesceMs): void {
    if (targets.length === 0) return;
    let bucket = this.coalescing.get(delayMs);
    if (!bucket) {
      const created = {
        targets: new Map<string, InvalidationTarget>(),
        timer: setTimeout(() => {
          this.coalescing.delete(delayMs);
          this.invalidate([...created.targets.values()]);
        }, delayMs),
      };
      bucket = created;
      this.coalescing.set(delayMs, bucket);
    }
    for (const t of targets) bucket.targets.set(targetKey(t), t);
  }

  private clearCoalescing(): void {
    for (const bucket of this.coalescing.values()) clearTimeout(bucket.timer);
    this.coalescing.clear();
  }

  /** Every key: active ones refresh once, inactive ones go stale. */
  invalidateAll(): void {
    for (const entry of this.entries.values()) this.invalidateEntry(entry);
  }

  /**
   * Read through the cache without subscribing (bootstrap reads, imperative
   * callers). Fresh data resolves immediately; otherwise it joins the shared
   * in-flight GET or starts one. Rejects with the {@link ApiError}.
   */
  read<T>(resource: Resource<T>): Promise<T> {
    const entry = this.ensure(resource as Resource<unknown>);
    if (!entry.inFlight && !entry.stale && entry.snapshot.data !== undefined && entry.snapshot.error === null) {
      return Promise.resolve(entry.snapshot.data as T);
    }
    if (!entry.inFlight) this.load(entry);
    const minGeneration = entry.generation;
    return new Promise<T>((resolve, reject) => {
      entry.waiters.push({ minGeneration, resolve: resolve as (v: unknown) => void, reject });
    });
  }

  /**
   * Replace a key's data with an authoritative write response. Supersedes any
   * in-flight GET for the key (its older result is dropped).
   */
  write<T>(resource: Resource<T>, data: T): void {
    const entry = this.ensure(resource as Resource<unknown>);
    this.cancelLoad(entry);
    entry.stale = false;
    entry.dirty = false;
    this.setSnapshot(entry, { data, error: null, loading: false, refreshing: false, updatedAt: this.now() });
    this.settleWaiters(entry, { ok: true, value: data }, Number.POSITIVE_INFINITY);
    this.syncRefreshTimer(entry);
    if (entry.listeners.size === 0) this.scheduleExpiry(entry);
  }

  /** Release every timer, request, waiter and the websocket. The store stays usable. */
  dispose(): void {
    this.clearCoalescing();
    for (const entry of this.entries.values()) {
      this.cancelLoad(entry);
      this.settleWaiters(entry, { ok: false, error: abortError() }, Number.POSITIVE_INFINITY);
      if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
      entry.expiryTimer = null;
      if (entry.refreshTimer) clearInterval(entry.refreshTimer);
      entry.refreshTimer = null;
      entry.listeners.clear();
      entry.stale = true;
      entry.dirty = false;
    }
    this.activeSubscriptions = 0;
    this.detachScheduled = false;
    if (this.detachSource) {
      this.detachSource();
      this.detachSource = null;
    }
  }

  // --- introspection (tests / diagnostics) -----------------------------------

  get subscriptionCount(): number {
    return this.activeSubscriptions;
  }

  get sourceAttached(): boolean {
    return this.detachSource !== null;
  }

  hasEntry(url: string): boolean {
    return this.entries.has(url);
  }

  isStale(url: string): boolean {
    return this.entries.get(url)?.stale ?? false;
  }

  // --- internals ---------------------------------------------------------------

  private ensure(resource: Resource<unknown>): Entry {
    let entry = this.entries.get(resource.url);
    if (!entry) {
      entry = {
        url: resource.url,
        resource,
        snapshot: LOADING_SNAPSHOT,
        listeners: new Set(),
        generation: 0,
        controller: null,
        inFlight: false,
        dirty: false,
        stale: false,
        waiters: [],
        expiryTimer: null,
        refreshTimer: null,
      };
      this.entries.set(resource.url, entry);
    }
    return entry;
  }

  private setSnapshot(entry: Entry, next: ResourceSnapshot<unknown>): void {
    const prev = entry.snapshot;
    if (
      prev.data === next.data &&
      prev.error === next.error &&
      prev.loading === next.loading &&
      prev.refreshing === next.refreshing &&
      prev.updatedAt === next.updatedAt
    ) {
      return;
    }
    entry.snapshot = next.data === undefined && next.error === null && next.loading && !next.refreshing
      ? LOADING_SNAPSHOT
      : Object.freeze({ ...next });
    for (const listener of [...entry.listeners]) listener();
  }

  private invalidateEntry(entry: Entry): void {
    if (entry.inFlight) {
      entry.dirty = true;
    } else if (entry.listeners.size > 0) {
      this.load(entry);
    } else {
      entry.stale = true;
    }
  }

  private load(entry: Entry): void {
    entry.controller?.abort();
    const generation = ++entry.generation;
    const controller = new AbortController();
    entry.controller = controller;
    entry.inFlight = true;
    entry.dirty = false;
    entry.stale = false;
    const prev = entry.snapshot;
    const hasData = prev.data !== undefined;
    this.setSnapshot(entry, { ...prev, loading: !hasData, refreshing: hasData });

    this.client.requestJson<unknown>(entry.url, { signal: controller.signal }).then(
      (data) => {
        if (generation !== entry.generation) return;
        entry.controller = null;
        entry.inFlight = false;
        this.setSnapshot(entry, { data, error: null, loading: false, refreshing: false, updatedAt: this.now() });
        this.settleWaiters(entry, { ok: true, value: data }, generation);
        this.afterSettle(entry);
      },
      (err: unknown) => {
        if (generation !== entry.generation) return;
        entry.controller = null;
        entry.inFlight = false;
        if (isAbortError(err)) {
          // Aborted from outside our own bookkeeping: nothing learned.
          entry.stale = true;
          this.setSnapshot(entry, { ...entry.snapshot, loading: false, refreshing: false });
          this.settleWaiters(entry, { ok: false, error: err }, generation);
          this.afterSettle(entry);
          return;
        }
        const error = toApiError(err, entry.url);
        const current = entry.snapshot;
        this.setSnapshot(entry, { data: current.data, error, loading: false, refreshing: false, updatedAt: current.updatedAt });
        this.settleWaiters(entry, { ok: false, error }, generation);
        this.afterSettle(entry);
      },
    );
  }

  private afterSettle(entry: Entry): void {
    if (entry.dirty) {
      entry.dirty = false;
      if (entry.listeners.size > 0 || entry.waiters.length > 0) {
        this.load(entry);
        return;
      }
      entry.stale = true;
    }
    this.syncRefreshTimer(entry);
    if (entry.listeners.size === 0) this.scheduleExpiry(entry);
  }

  /** Abort and forget the in-flight load (its late result is ignored). */
  private cancelLoad(entry: Entry): void {
    if (!entry.inFlight) return;
    entry.generation += 1;
    entry.controller?.abort();
    entry.controller = null;
    entry.inFlight = false;
    entry.stale = true;
    const snap = entry.snapshot;
    this.setSnapshot(entry, { ...snap, loading: snap.data === undefined && snap.error === null, refreshing: false });
  }

  private deactivate(entry: Entry): void {
    if (entry.inFlight && entry.waiters.length === 0) {
      // Nobody is waiting for this answer any more.
      entry.dirty = false;
      this.cancelLoad(entry);
    }
    this.syncRefreshTimer(entry);
    if (entry.resource.retain === false && !entry.inFlight && entry.waiters.length === 0) {
      if (this.entries.get(entry.url) === entry) this.entries.delete(entry.url);
      return;
    }
    this.scheduleExpiry(entry);
  }

  private settleWaiters(
    entry: Entry,
    outcome: { ok: true; value: unknown } | { ok: false; error: unknown },
    generation: number,
  ): void {
    if (entry.waiters.length === 0) return;
    const ready = entry.waiters.filter((w) => w.minGeneration <= generation);
    entry.waiters = entry.waiters.filter((w) => w.minGeneration > generation);
    for (const w of ready) {
      if (outcome.ok) w.resolve(outcome.value);
      else w.reject(outcome.error);
    }
  }

  private scheduleExpiry(entry: Entry): void {
    if (entry.expiryTimer || entry.listeners.size > 0) return;
    entry.expiryTimer = setTimeout(() => {
      entry.expiryTimer = null;
      if (entry.listeners.size > 0) return;
      if (entry.inFlight || entry.waiters.length > 0) {
        this.scheduleExpiry(entry);
        return;
      }
      if (this.entries.get(entry.url) === entry) this.entries.delete(entry.url);
    }, this.inactiveTtlMs);
  }

  private syncRefreshTimer(entry: Entry): void {
    const policy = entry.resource.refresh;
    const data = entry.snapshot.data;
    const shouldRun = Boolean(policy) && entry.listeners.size > 0 && data !== undefined && policy!.while(data);
    if (shouldRun && !entry.refreshTimer) {
      entry.refreshTimer = setInterval(() => {
        if (entry.listeners.size > 0 && this.isVisible()) this.refetch(entry.url);
      }, policy!.intervalMs);
    } else if (!shouldRun && entry.refreshTimer) {
      clearInterval(entry.refreshTimer);
      entry.refreshTimer = null;
    }
  }

  private attachSource(): void {
    this.detachScheduled = false;
    if (!this.source || this.detachSource) return;
    const offMessages = this.source.subscribeMessages((message) => {
      this.scheduleInvalidate(
        invalidationsForMessage(message),
        message.type === 'agent-sessions-updated' ? this.sessionCoalesceMs : this.coalesceMs,
      );
    });
    const offReconnect = this.source.subscribeReconnect(() => this.invalidateAll());
    this.detachSource = () => {
      offMessages();
      offReconnect();
    };
  }

  private scheduleDetach(): void {
    if (!this.detachSource || this.detachScheduled) return;
    this.detachScheduled = true;
    // Deferred so a same-commit unsubscribe → subscribe (StrictMode, route
    // swaps) keeps the socket instead of closing and redialling it.
    queueMicrotask(() => {
      if (!this.detachScheduled) return;
      this.detachScheduled = false;
      if (this.activeSubscriptions > 0 || !this.detachSource) return;
      this.detachSource();
      this.detachSource = null;
      // Updates can no longer be observed: nothing cached is trustworthy.
      this.clearCoalescing();
      for (const entry of this.entries.values()) {
        if (!entry.inFlight) entry.stale = true;
      }
    });
  }
}

/** The shared dashboard websocket (wsManager) as an invalidation source. */
export const wsInvalidationSource: InvalidationSource = {
  subscribeMessages: (listener) => subscribeWs(listener),
  subscribeReconnect: (listener) => subscribeReconnect(listener),
};

let defaultStore: ResourceStore | null = null;

/** The browser app's store (lazily created; SSR-safe — it does nothing until subscribed). */
export function getDefaultResourceStore(): ResourceStore {
  if (!defaultStore) {
    defaultStore = new ResourceStore({ source: typeof window !== 'undefined' ? wsInvalidationSource : null });
  }
  return defaultStore;
}

/** Test-only: dispose and forget the default store. */
export function __resetDefaultResourceStoreForTests(): void {
  defaultStore?.dispose();
  defaultStore = null;
}
