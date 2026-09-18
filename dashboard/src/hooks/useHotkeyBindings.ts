// Retained only until Task 6 removes the custom binding editor (hotkey choice A).
import { useMemo } from 'react';
import {
  BINDABLE_ACTION_KINDS,
  canonicalizeCombo,
  isBindableActionKind,
  type BindableActionKind,
} from '@shared/hotkeys-catalog';
import { getDefaultResourceStore } from '../data/cache';
import { mutate } from '../data/mutate';
import { resources } from '../data/resources';
import { useResource } from '../data/useResource';

export interface HotkeyBindingsResponse {
  bindings: Partial<Record<BindableActionKind, string>>;
  custom: boolean;
}

const DEFAULT_BINDINGS: HotkeyBindingsResponse = {
  bindings: {},
  custom: false,
};

const hotkeysResource = () => resources.config<unknown>('hotkeys');

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
  return getDefaultResourceStore()
    .read(hotkeysResource())
    .then(normalize, () => DEFAULT_BINDINGS);
}

export function useHotkeyBindings(): HotkeyBindingsResponse {
  const { data } = useResource(hotkeysResource());
  return useMemo(() => normalize(data), [data]);
}

export function invalidateHotkeyBindingsCache(): void {
  getDefaultResourceStore().invalidate([{ tag: 'config', configKind: 'hotkeys' }]);
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
  const response = await mutate<unknown>('PUT', hotkeysResource().url, { bindings: payload });
  getDefaultResourceStore().write(hotkeysResource(), response);
  return normalize(response);
}

export async function resetHotkeyBindings(): Promise<HotkeyBindingsResponse> {
  const response = await mutate<unknown>('DELETE', hotkeysResource().url);
  getDefaultResourceStore().write(hotkeysResource(), response);
  return normalize(response);
}
