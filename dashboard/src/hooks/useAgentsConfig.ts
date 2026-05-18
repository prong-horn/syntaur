import { useState, useEffect } from 'react';
import { PROMPT_ARG_POSITIONS, type AgentConfig, type PromptArgPosition } from '@shared/agents-schema';

export interface AgentsConfigResponse {
  agents: AgentConfig[];
  custom: boolean;
}

export interface FieldError {
  id?: string;
  index?: number;
  field: string;
  message: string;
}

export class AgentsConfigError extends Error {
  fieldErrors?: FieldError[];
  constructor(message: string, fieldErrors?: FieldError[]) {
    super(message);
    this.name = 'AgentsConfigError';
    this.fieldErrors = fieldErrors;
  }
}

const DEFAULT: AgentsConfigResponse = { agents: [], custom: false };

let cachedConfig: AgentsConfigResponse | null = null;
let fetchPromise: Promise<AgentsConfigResponse> | null = null;
let generation = 0;
const subscribers = new Set<(value: AgentsConfigResponse) => void>();

function notify(next: AgentsConfigResponse): void {
  cachedConfig = next;
  for (const sub of subscribers) sub(next);
}

function normalizeRow(raw: unknown): AgentConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.id !== 'string' || entry.id.length === 0) return null;
  if (typeof entry.label !== 'string') return null;
  if (typeof entry.command !== 'string') return null;
  const agent: AgentConfig = {
    id: entry.id,
    label: entry.label,
    command: entry.command,
  };
  if (Array.isArray(entry.args) && entry.args.every((v) => typeof v === 'string')) {
    agent.args = entry.args as string[];
  }
  if (
    typeof entry.promptArgPosition === 'string' &&
    PROMPT_ARG_POSITIONS.includes(entry.promptArgPosition as PromptArgPosition)
  ) {
    agent.promptArgPosition = entry.promptArgPosition as PromptArgPosition;
  }
  if (typeof entry.resolveFromShellAliases === 'boolean') {
    agent.resolveFromShellAliases = entry.resolveFromShellAliases;
  }
  if (typeof entry.default === 'boolean') {
    agent.default = entry.default;
  }
  return agent;
}

function normalize(data: unknown): AgentsConfigResponse {
  if (!data || typeof data !== 'object') return DEFAULT;
  const raw = data as { agents?: unknown; custom?: unknown };
  const list = Array.isArray(raw.agents) ? raw.agents : [];
  const agents: AgentConfig[] = [];
  for (const row of list) {
    const normalized = normalizeRow(row);
    if (normalized) agents.push(normalized);
  }
  return { agents, custom: raw.custom === true };
}

export function fetchAgentsConfig(): Promise<AgentsConfigResponse> {
  if (cachedConfig) return Promise.resolve(cachedConfig);
  if (fetchPromise) return fetchPromise;

  const gen = ++generation;
  fetchPromise = fetch('/api/config/agents')
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

export function useAgentsConfig(): AgentsConfigResponse {
  const [config, setConfig] = useState<AgentsConfigResponse>(
    () => cachedConfig ?? DEFAULT,
  );

  useEffect(() => {
    let cancelled = false;
    fetchAgentsConfig().then((next) => {
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

export function invalidateAgentsConfigCache(): void {
  cachedConfig = null;
  fetchPromise = null;
  ++generation;
}

async function readErrorBody(res: Response): Promise<AgentsConfigError> {
  const body = (await res.json().catch(() => null)) as
    | { error?: string; fieldErrors?: FieldError[] }
    | null;
  const message = body?.error ?? `HTTP ${res.status}`;
  return new AgentsConfigError(message, body?.fieldErrors);
}

export async function saveAgentsConfig(
  agents: AgentConfig[],
): Promise<AgentsConfigResponse> {
  ++generation;
  const res = await fetch('/api/config/agents', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agents }),
  });
  if (!res.ok) throw await readErrorBody(res);
  const normalized = normalize(await res.json());
  notify(normalized);
  return normalized;
}

export async function resetAgentsConfig(): Promise<AgentsConfigResponse> {
  ++generation;
  const res = await fetch('/api/config/agents', { method: 'DELETE' });
  if (!res.ok) throw await readErrorBody(res);
  const normalized = normalize(await res.json());
  notify(normalized);
  return normalized;
}
