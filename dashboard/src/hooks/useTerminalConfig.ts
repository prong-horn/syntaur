import { useState, useEffect } from 'react';
import { TERMINAL_CHOICES, type TerminalChoice } from '@shared/terminal-schema';

export interface TerminalConfigResponse {
  terminal: TerminalChoice;
  custom: boolean;
}

const DEFAULT: TerminalConfigResponse = { terminal: 'terminal-app', custom: false };

let cachedConfig: TerminalConfigResponse | null = null;
let fetchPromise: Promise<TerminalConfigResponse> | null = null;
let generation = 0;
const subscribers = new Set<(value: TerminalConfigResponse) => void>();

function notify(next: TerminalConfigResponse): void {
  cachedConfig = next;
  for (const sub of subscribers) sub(next);
}

function normalize(data: unknown): TerminalConfigResponse {
  if (!data || typeof data !== 'object') return DEFAULT;
  const raw = data as { terminal?: unknown; custom?: unknown };
  const terminal =
    typeof raw.terminal === 'string' &&
    (TERMINAL_CHOICES as readonly string[]).includes(raw.terminal)
      ? (raw.terminal as TerminalChoice)
      : DEFAULT.terminal;
  return { terminal, custom: raw.custom === true };
}

export function fetchTerminalConfig(): Promise<TerminalConfigResponse> {
  if (cachedConfig) return Promise.resolve(cachedConfig);
  if (fetchPromise) return fetchPromise;

  const gen = ++generation;
  fetchPromise = fetch('/api/config/terminal')
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((data) => {
      fetchPromise = null;
      const normalized = normalize(data);
      if (gen !== generation) {
        return cachedConfig ?? normalized;
      }
      cachedConfig = normalized;
      return normalized;
    })
    .catch(() => {
      fetchPromise = null;
      return DEFAULT;
    });

  return fetchPromise;
}

export function useTerminalConfig(): TerminalConfigResponse {
  const [config, setConfig] = useState<TerminalConfigResponse>(
    () => cachedConfig ?? DEFAULT,
  );

  useEffect(() => {
    let cancelled = false;
    fetchTerminalConfig().then((next) => {
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

export function invalidateTerminalConfigCache(): void {
  cachedConfig = null;
  fetchPromise = null;
  ++generation;
}

export async function saveTerminalConfig(
  terminal: TerminalChoice,
): Promise<TerminalConfigResponse> {
  ++generation;
  const res = await fetch('/api/config/terminal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ terminal }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  const normalized = normalize(await res.json());
  notify(normalized);
  return normalized;
}

export async function resetTerminalConfig(): Promise<TerminalConfigResponse> {
  ++generation;
  const res = await fetch('/api/config/terminal', { method: 'DELETE' });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  const normalized = normalize(await res.json());
  notify(normalized);
  return normalized;
}
