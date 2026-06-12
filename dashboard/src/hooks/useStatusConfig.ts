import { useState, useEffect } from 'react';
import type { FactDeclaration, RawFactDeclaration } from '@shared/fact-registry';
import { DEFAULT_DERIVE_CONFIG, type DeriveConfig } from '@shared/derive-config';

export interface StatusDefinition {
  id: string;
  label: string;
  description?: string;
  color?: string;
  icon?: string;
  terminal?: boolean;
}

export interface StatusTransition {
  from: string;
  command: string;
  to: string;
  label?: string;
  description?: string;
  requiresReason?: boolean;
}

export interface StatusConfigResponse {
  statuses: StatusDefinition[];
  order: string[];
  transitions: StatusTransition[];
  custom: boolean;
  /** Always a concrete config (defaults when the file declares none). */
  derive: DeriveConfig;
  /** Whether the config.md actually customizes the derive rules. */
  deriveCustom: boolean;
  /** Built-in transition command names, for the transitions-editor pickers. */
  knownCommands: string[];
  factDeclarations: FactDeclaration[];
  rawFacts: RawFactDeclaration[];
}

// Shared client types for the orphan-prompt feature. Mirror server shapes
// in src/dashboard/api-status-config.ts.

export type StatusResolution =
  | { id: string; mode: 'remap'; target: string }
  | { id: string; mode: 'delete' };

export interface AffectedAssignmentSummary {
  display: string;
  projectSlug: string | null;
  assignmentSlug: string;
  status: string;
}

export interface AffectedResponse {
  id: string;
  count: number;
  truncated: boolean;
  assignments: AffectedAssignmentSummary[];
}

export interface StatusConfigSaveResponse extends StatusConfigResponse {
  applied?: {
    remapped: number;
    deleted: number;
    byId: Record<string, { mode: 'remap' | 'delete'; count: number; target?: string }>;
  };
}

const DEFAULT_STATUS_CONFIG: StatusConfigResponse = {
  statuses: [
    { id: 'pending', label: 'Pending' },
    { id: 'in_progress', label: 'In Progress' },
    { id: 'blocked', label: 'Blocked' },
    { id: 'review', label: 'Review' },
    { id: 'completed', label: 'Completed' },
    { id: 'failed', label: 'Failed' },
  ],
  order: ['pending', 'in_progress', 'blocked', 'review', 'completed', 'failed'],
  transitions: [],
  custom: false,
  derive: DEFAULT_DERIVE_CONFIG,
  deriveCustom: false,
  knownCommands: [],
  factDeclarations: [],
  rawFacts: [],
};

let cachedConfig: StatusConfigResponse | null = null;
let fetchPromise: Promise<StatusConfigResponse> | null = null;

function fetchStatusConfig(): Promise<StatusConfigResponse> {
  if (cachedConfig) return Promise.resolve(cachedConfig);
  if (fetchPromise) return fetchPromise;

  fetchPromise = fetch('/api/config/statuses')
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<StatusConfigResponse>;
    })
    .then((data) => {
      cachedConfig = data;
      fetchPromise = null;
      return data;
    })
    .catch(() => {
      fetchPromise = null;
      return DEFAULT_STATUS_CONFIG;
    });

  return fetchPromise;
}

export function useStatusConfig(): StatusConfigResponse {
  const [config, setConfig] = useState<StatusConfigResponse>(
    () => cachedConfig ?? DEFAULT_STATUS_CONFIG,
  );

  useEffect(() => {
    fetchStatusConfig().then(setConfig);
  }, []);

  return config;
}

export function invalidateStatusConfigCache(): void {
  cachedConfig = null;
  fetchPromise = null;
}

export function getStatusLabel(config: StatusConfigResponse, statusId: string): string {
  const found = config.statuses.find((s) => s.id === statusId);
  return found?.label ?? statusId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
