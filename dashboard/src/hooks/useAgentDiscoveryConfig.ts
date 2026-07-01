import { useState, useEffect } from 'react';

export interface AgentDiscoveryConfig {
  claudeGlobal: boolean;
  claudeProject: boolean;
  directory: boolean;
  roots: string[];
}

export interface AgentDiscoverySettings {
  agentDiscovery: AgentDiscoveryConfig;
  standaloneDefaultCwd: string | null;
}

const DEFAULT: AgentDiscoverySettings = {
  agentDiscovery: { claudeGlobal: true, claudeProject: true, directory: true, roots: ['~'] },
  standaloneDefaultCwd: null,
};

function normalize(data: unknown): AgentDiscoverySettings {
  if (!data || typeof data !== 'object') return DEFAULT;
  const raw = data as {
    agentDiscovery?: Partial<AgentDiscoveryConfig>;
    standaloneDefaultCwd?: unknown;
  };
  const d = raw.agentDiscovery ?? {};
  const roots =
    Array.isArray(d.roots) && d.roots.length
      ? d.roots.filter((r): r is string => typeof r === 'string' && r.trim() !== '')
      : ['~'];
  return {
    agentDiscovery: {
      claudeGlobal: d.claudeGlobal !== false,
      claudeProject: d.claudeProject !== false,
      directory: d.directory !== false,
      roots: roots.length ? roots : ['~'],
    },
    standaloneDefaultCwd:
      typeof raw.standaloneDefaultCwd === 'string' ? raw.standaloneDefaultCwd : null,
  };
}

export function useAgentDiscoveryConfig(): {
  settings: AgentDiscoverySettings;
  loading: boolean;
  reload: () => void;
} {
  const [settings, setSettings] = useState<AgentDiscoverySettings>(DEFAULT);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch('/api/config/agent-discovery')
      .then((res) => (res.ok ? res.json() : DEFAULT))
      .then((data) => {
        if (!cancelled) {
          setSettings(normalize(data));
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSettings(DEFAULT);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);
  return { settings, loading, reload: () => setNonce((n) => n + 1) };
}

export async function saveAgentDiscoveryConfig(
  settings: AgentDiscoverySettings,
): Promise<AgentDiscoverySettings> {
  const res = await fetch('/api/config/agent-discovery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  return normalize(await res.json());
}
