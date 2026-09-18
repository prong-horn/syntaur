/**
 * React binding for the resource store: `useResource` is the ONE URL-backed
 * read hook; `ResourceProvider` scopes a store instance (the browser singleton
 * in the app, isolated stores in tests/SSR).
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { ApiClient, ApiError } from './client';
import {
  DISABLED_SNAPSHOT,
  ResourceStore,
  getDefaultResourceStore,
  type InvalidationSource,
  type ResourceSnapshot,
} from './cache';
import type { Resource } from './resources';

const ResourceContext = createContext<ResourceStore | null>(null);

export interface ResourceProviderProps {
  /** Use this store as-is (not disposed by the provider). */
  store?: ResourceStore;
  /** Otherwise the provider owns a fresh store built from these. */
  client?: ApiClient;
  source?: InvalidationSource | null;
  seed?: Iterable<readonly [Resource<unknown>, unknown]>;
  children?: ReactNode;
}

/**
 * Scope a resource store. With `store` the provider only shares it; without,
 * it builds an isolated store (seeded for SSR/tests) and releases its timers,
 * requests and socket on unmount. Disposal leaves the store reusable, so
 * StrictMode's unmount/remount cycle is safe.
 */
export function ResourceProvider(props: ResourceProviderProps) {
  const { store: provided, client, source, seed, children } = props;
  const [owned] = useState<ResourceStore | null>(() =>
    provided ? null : new ResourceStore({ client, source: source ?? null, seed }),
  );
  const store = provided ?? owned!;
  useEffect(() => {
    if (!owned) return undefined;
    return () => owned.dispose();
  }, [owned]);
  return createElement(ResourceContext.Provider, { value: store }, children);
}

/** The nearest provider's store, else the browser singleton. */
export function useResourceStore(): ResourceStore {
  return useContext(ResourceContext) ?? getDefaultResourceStore();
}

export interface ResourceState<T> {
  data: T | undefined;
  error: ApiError | null;
  /** Nothing to show yet for THIS key and it is loading. */
  loading: boolean;
  /** Showing this key's data while it reloads. */
  refreshing: boolean;
  /** Reload this key; resolves when that reload settles (never rejects). */
  refetch: () => Promise<void>;
}

const noopUnsubscribe = () => {};

/**
 * Subscribe to a finite GET resource. `null` disables it: no request, no
 * subscription, `loading: false`. Keyed by the descriptor's URL, so rebuilding
 * an equivalent descriptor during render never resubscribes; a different URL
 * never shows another key's data.
 */
export function useResource<T>(resource: Resource<T> | null): ResourceState<T> {
  const store = useResourceStore();
  const url = resource?.url ?? null;

  // Recreated only when the URL changes, so it captures the descriptor of the
  // render that introduced this URL (tags/policies are a pure function of the
  // builder inputs that produced the URL).
  const subscribe = useCallback(
    (onChange: () => void) => (resource ? store.subscribe(resource as Resource<unknown>, onChange) : noopUnsubscribe),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, url],
  );
  const getSnapshot = useCallback(
    (): ResourceSnapshot<T> => (url ? store.getSnapshot<T>(url) : DISABLED_SNAPSHOT),
    [store, url],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const refetch = useCallback((): Promise<void> => (url ? store.refetch(url) : Promise.resolve()), [store, url]);

  return useMemo(
    () => ({
      data: snapshot.data,
      error: snapshot.error,
      loading: snapshot.loading,
      refreshing: snapshot.refreshing,
      refetch,
    }),
    [snapshot, refetch],
  );
}
