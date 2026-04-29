import { useState, useEffect } from 'react';
import {
  BINDABLE_ACTION_KINDS,
  canonicalizeCombo,
  isBindableActionKind,
  type BindableActionKind,
} from '@shared/hotkeys-catalog';

export interface HotkeyBindingsResponse {
  bindings: Partial<Record<BindableActionKind, string>>;
  custom: boolean;
}

const DEFAULT_BINDINGS: HotkeyBindingsResponse = {
  bindings: {},
  custom: false,
};

let cachedConfig: HotkeyBindingsResponse | null = null;
let fetchPromise: Promise<HotkeyBindingsResponse> | null = null;
const subscribers = new Set<(value: HotkeyBindingsResponse) => void>();

function notify(next: HotkeyBindingsResponse): void {
  cachedConfig = next;
  for (const sub of subscribers) sub(next);
}

function normalize(data: unknown): HotkeyBindingsResponse {
  if (!data || typeof data !== 'object') return DEFAULT_BINDINGS;
  const raw = data as { bindings?: unknown; custom?: unknown };
  const bindings: Partial<Record<BindableActionKind, string>> = {};
  if (raw.bindings && typeof raw.bindings === 'object' && !Array.isArray(raw.bindings)) {
    for (const [k, v] of Object.entries(raw.bindings as Record<string, unknown>)) {
      if (!isBindableActionKind(k)) continue;
      if (typeof v !== 'string' || v.trim() === '') continue;
      const canonical = canonicalizeCombo(v);
      if (!canonical) continue;
      bindings[k] = canonical;
    }
  }
  return { bindings, custom: raw.custom === true };
}

export function fetchHotkeyBindings(): Promise<HotkeyBindingsResponse> {
  if (cachedConfig) return Promise.resolve(cachedConfig);
  if (fetchPromise) return fetchPromise;

  fetchPromise = fetch('/api/config/hotkeys')
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((data) => {
      const normalized = normalize(data);
      cachedConfig = normalized;
      fetchPromise = null;
      return normalized;
    })
    .catch(() => {
      fetchPromise = null;
      return DEFAULT_BINDINGS;
    });

  return fetchPromise;
}

export function useHotkeyBindings(): HotkeyBindingsResponse {
  const [config, setConfig] = useState<HotkeyBindingsResponse>(
    () => cachedConfig ?? DEFAULT_BINDINGS,
  );

  useEffect(() => {
    let cancelled = false;
    fetchHotkeyBindings().then((next) => {
      if (!cancelled) setConfig(next);
    });
    subscribers.add(setConfig);
    return () => {
      cancelled = true;
      subscribers.delete(setConfig);
    };
  }, []);

  return config;
}

export function invalidateHotkeyBindingsCache(): void {
  cachedConfig = null;
  fetchPromise = null;
}

export async function saveHotkeyBindings(
  bindings: Partial<Record<BindableActionKind, string>>,
): Promise<HotkeyBindingsResponse> {
  // Filter to known kinds + canonicalize on the wire to keep server payloads
  // tidy and to match the storage form the server will return.
  const payload: Partial<Record<BindableActionKind, string>> = {};
  for (const kind of BINDABLE_ACTION_KINDS) {
    const value = bindings[kind];
    if (typeof value !== 'string') continue;
    const canonical = canonicalizeCombo(value);
    if (!canonical) continue;
    payload[kind] = canonical;
  }

  const res = await fetch('/api/config/hotkeys', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bindings: payload }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error ?? 'Failed to save hotkey bindings');
  }
  const normalized = normalize(await res.json());
  notify(normalized);
  return normalized;
}

export async function resetHotkeyBindings(): Promise<HotkeyBindingsResponse> {
  const res = await fetch('/api/config/hotkeys', { method: 'DELETE' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const normalized = normalize(await res.json());
  notify(normalized);
  return normalized;
}
