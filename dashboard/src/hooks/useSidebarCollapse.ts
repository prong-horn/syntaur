import { useSyncExternalStore } from 'react';

// Per-client persistence for the sidebar collapse state — both the global nav
// groups (`library`/`board`/`operations`) and the workspace sections
// (`ws:<name>`). Backed by a module-level external store read via
// `useSyncExternalStore` so the two simultaneously-mounted `ShellSidebar`
// instances (the CSS-hidden desktop `<aside>` and the mobile overlay) share one
// source of truth and re-render together — plain `useState` would let them
// desync until reload. Mirrors the SSR/quota-safe guard style of
// `useTodoSectionCollapse` and the external-store pattern of `wsManager`.

const STORAGE_KEY = 'syntaur.sidebar.collapsed.v1';

export type CollapseMap = Record<string, boolean>;

// Reading `window.localStorage` *itself* can throw (e.g. when storage is blocked
// by the browser), so guard the property access — not just get/set.
function safeStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Parse a raw localStorage value into a CollapseMap, tolerating bad input. */
export function parseCollapse(raw: string | null): CollapseMap {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: CollapseMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'boolean') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Return a new map with `id`'s collapsed flag flipped (default = expanded). */
export function applyToggle(map: CollapseMap, id: string): CollapseMap {
  return { ...map, [id]: !(map[id] ?? false) };
}

function readInitial(): CollapseMap {
  const storage = safeStorage();
  if (!storage) return {};
  try {
    return parseCollapse(storage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}

// Module-level store + listeners. `store` is only reassigned on an actual
// change, so `getSnapshot` returns a stable reference between toggles (required
// by `useSyncExternalStore` to avoid an infinite render loop).
let store: CollapseMap = readInitial();
const listeners = new Set<() => void>();
const EMPTY: CollapseMap = {};

function persist(next: CollapseMap): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // quota/security errors — collapse state is non-critical, skip.
  }
}

// Does NOT invoke the listener immediately (honours the `useSyncExternalStore`
// subscribe contract). Returns an unsubscribe fn so StrictMode/remounts don't
// leak listeners.
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): CollapseMap {
  return store;
}

function getServerSnapshot(): CollapseMap {
  return EMPTY;
}

function toggleId(id: string): void {
  store = applyToggle(store, id);
  persist(store);
  for (const listener of listeners) listener();
}

export interface SidebarCollapse {
  /** `defaultCollapsed` applies when `id` has no stored preference (default expanded). */
  isCollapsed: (id: string, defaultCollapsed?: boolean) => boolean;
  toggle: (id: string) => void;
}

export function useSidebarCollapse(): SidebarCollapse {
  const map = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const isCollapsed = (id: string, defaultCollapsed = false): boolean =>
    map[id] ?? defaultCollapsed;
  return { isCollapsed, toggle: toggleId };
}
