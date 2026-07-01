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
  if (typeof entry.model === 'string') {
    agent.model = entry.model;
  }
  if (typeof entry.playbook === 'string') {
    agent.playbook = entry.playbook;
  }
  if (typeof entry.launchPrompt === 'string') {
    agent.launchPrompt = entry.launchPrompt;
  }
  if (typeof entry.agentName === 'string') {
    agent.agentName = entry.agentName;
  }
  if (typeof entry.workdir === 'string') {
    agent.workdir = entry.workdir;
  }
  if (entry.runner === 'claude' || entry.runner === 'pi' || entry.runner === 'codex') {
    agent.runner = entry.runner;
  }
  if (typeof entry.sourceKind === 'string') {
    agent.sourceKind = entry.sourceKind as AgentConfig['sourceKind'];
  }
  if (typeof entry.sourcePath === 'string') {
    agent.sourcePath = entry.sourcePath;
  }
  if (typeof entry.sourceRepo === 'string') {
    agent.sourceRepo = entry.sourceRepo;
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

/** A Claude agent definition discovered on disk (`~/.claude/agents`). */
export interface DiscoveredClaudeAgent {
  name: string;
  description?: string;
  model?: string;
  path: string;
}

/**
 * Fetch the Claude agent definitions discovered on disk for the "Run as agent"
 * picker. Returns `[]` on any error (Claude not installed, no agents dir).
 * Lightweight one-shot fetch — no shared cache (the list is small and the
 * picker mounts rarely).
 */
export function useClaudeDiscoveredAgents(): DiscoveredClaudeAgent[] {
  const [agents, setAgents] = useState<DiscoveredClaudeAgent[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/config/agents/claude-discovered')
      .then((res) => (res.ok ? res.json() : { agents: [] }))
      .then((data: { agents?: unknown }) => {
        if (cancelled) return;
        const list = Array.isArray(data.agents) ? data.agents : [];
        const cleaned: DiscoveredClaudeAgent[] = [];
        for (const raw of list) {
          if (!raw || typeof raw !== 'object') continue;
          const e = raw as Record<string, unknown>;
          if (typeof e.name !== 'string' || !e.name) continue;
          cleaned.push({
            name: e.name,
            description: typeof e.description === 'string' ? e.description : undefined,
            model: typeof e.model === 'string' ? e.model : undefined,
            path: typeof e.path === 'string' ? e.path : '',
          });
        }
        setAgents(cleaned);
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return agents;
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

/** A discovered, not-yet-registered agent candidate for the register tray. */
export interface DiscoveredCandidate {
  name: string;
  runner: 'claude' | 'pi' | 'codex';
  description?: string;
  path: string;
  source: 'claude-global' | 'claude-project' | 'directory';
  recommended: boolean;
  alreadyRegistered: boolean;
}

export async function fetchDiscoveredAgents(
  repo?: string | null,
): Promise<DiscoveredCandidate[]> {
  const qs = repo ? `?repo=${encodeURIComponent(repo)}` : '';
  const res = await fetch(`/api/config/agents/discovered${qs}`);
  if (!res.ok) return [];
  const data = (await res.json().catch(() => null)) as { candidates?: unknown } | null;
  return Array.isArray(data?.candidates) ? (data!.candidates as DiscoveredCandidate[]) : [];
}

/** Fetch discovered candidates for the register tray; `reload()` re-fetches. */
export function useDiscoveredAgents(repo?: string | null): {
  candidates: DiscoveredCandidate[];
  loading: boolean;
  reload: () => void;
} {
  const [candidates, setCandidates] = useState<DiscoveredCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchDiscoveredAgents(repo)
      .then((c) => {
        if (!cancelled) {
          setCandidates(c);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCandidates([]);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [repo, nonce]);
  return { candidates, loading, reload: () => setNonce((n) => n + 1) };
}

async function postAgentsAction(path: string, body: unknown): Promise<AgentsConfigResponse> {
  ++generation;
  const res = await fetch(`/api/config/agents/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readErrorBody(res);
  const normalized = normalize(await res.json());
  notify(normalized);
  return normalized;
}

export interface RegisterAgentBody {
  path: string;
  name: string;
  runner: 'claude' | 'pi' | 'codex';
  sourceKind: 'claude-global' | 'claude-project' | 'directory';
  sourceRepo?: string;
  description?: string;
}
export const registerAgent = (body: RegisterAgentBody) => postAgentsAction('register', body);

export const manualAddAgent = (path: string) => postAgentsAction('manual-add', { path });

export interface CreateAgentBody {
  name: string;
  runner: 'claude' | 'pi' | 'codex';
  model?: string;
  description?: string;
  instructions: string;
  location?: string;
}
export const createAgent = (body: CreateAgentBody) => postAgentsAction('create', body);
