import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'syntaur.inbox.window.v1';

export type InboxWindow = '14d' | 'all';

function safeStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Parse a raw localStorage value; junk defaults to `'14d'`. */
export function parseWindow(raw: string | null): InboxWindow {
  if (raw === 'all') return 'all';
  return '14d';
}

function readInitial(): InboxWindow {
  const storage = safeStorage();
  if (!storage) return '14d';
  try {
    return parseWindow(storage.getItem(STORAGE_KEY));
  } catch {
    return '14d';
  }
}

let store: InboxWindow = readInitial();
const listeners = new Set<() => void>();

function persist(next: InboxWindow): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, next);
  } catch {
    // quota/security — non-critical
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): InboxWindow {
  return store;
}

function getServerSnapshot(): InboxWindow {
  return '14d';
}

function setWindowValue(next: InboxWindow): void {
  if (next === store) return;
  store = next;
  persist(store);
  for (const listener of listeners) listener();
}

export interface InboxWindowState {
  window: InboxWindow;
  setWindow: (value: InboxWindow) => void;
  maxAgeDays: 14 | null;
}

export function useInboxWindow(): InboxWindowState {
  const window = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return {
    window,
    setWindow: setWindowValue,
    maxAgeDays: window === '14d' ? 14 : null,
  };
}
