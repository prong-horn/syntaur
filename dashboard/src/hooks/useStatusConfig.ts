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
  /** RAW transitions (empty when the user declares none — see transitionsCustom). */
  order: string[];
  transitions: StatusTransition[];
  /** Whether config.md actually customizes transitions (false → show defaults read-only). */
  transitionsCustom: boolean;
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
  transitionsCustom: false,
  custom: false,
  derive: DEFAULT_DERIVE_CONFIG,
  deriveCustom: false,
  knownCommands: [],
  factDeclarations: [],
  rawFacts: [],
};

export const DEFAULT_WORKFLOW_ID = 'default';

/** The GET endpoint for a workflow's status config. The built-in `default`
 * keeps the legacy `/api/config/statuses` path (byte-identical response,
 * guaranteed to exist); every other workflow reads `/api/config/workflows/:id`. */
export function statusConfigEndpoint(workflowId: string): string {
  return workflowId === DEFAULT_WORKFLOW_ID
    ? '/api/config/statuses'
    : `/api/config/workflows/${encodeURIComponent(workflowId)}`;
}

interface ConfigCacheEntry {
  config: StatusConfigResponse | null;
  promise: Promise<StatusConfigResponse> | null;
}

// One cache entry per workflow id — a status edit to workflow A must not evict
// or stale-serve workflow B.
const configCaches = new Map<string, ConfigCacheEntry>();

function cacheFor(workflowId: string): ConfigCacheEntry {
  let entry = configCaches.get(workflowId);
  if (!entry) {
    entry = { config: null, promise: null };
    configCaches.set(workflowId, entry);
  }
  return entry;
}

function fetchStatusConfig(workflowId: string): Promise<StatusConfigResponse> {
  const entry = cacheFor(workflowId);
  if (entry.config) return Promise.resolve(entry.config);
  if (entry.promise) return entry.promise;

  entry.promise = fetch(statusConfigEndpoint(workflowId))
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<StatusConfigResponse>;
    })
    .then((data) => {
      entry.config = data;
      entry.promise = null;
      return data;
    })
    .catch(() => {
      entry.promise = null;
      return DEFAULT_STATUS_CONFIG;
    });

  return entry.promise;
}

export function useStatusConfig(
  workflowId: string = DEFAULT_WORKFLOW_ID,
): StatusConfigResponse {
  const [config, setConfig] = useState<StatusConfigResponse>(
    () => cacheFor(workflowId).config ?? DEFAULT_STATUS_CONFIG,
  );

  useEffect(() => {
    let alive = true;
    // Serve the cached config synchronously when the workflow changes, then
    // refresh from the network.
    setConfig(cacheFor(workflowId).config ?? DEFAULT_STATUS_CONFIG);
    fetchStatusConfig(workflowId).then((c) => {
      if (alive) setConfig(c);
    });
    return () => {
      alive = false;
    };
  }, [workflowId]);

  return config;
}

/** Invalidate one workflow's cached config, or (no arg) every workflow's config
 * AND the workflow-library list — call the no-arg form after create/delete/
 * set-default, which change the library shape. */
export function invalidateStatusConfigCache(workflowId?: string): void {
  if (workflowId === undefined) {
    configCaches.clear();
    invalidateWorkflowsCache();
    return;
  }
  configCaches.delete(workflowId);
}

export function getStatusLabel(config: StatusConfigResponse, statusId: string): string {
  const found = config.statuses.find((s) => s.id === statusId);
  return found?.label ?? statusId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Workflow library (list) ─────────────────────────────────────────────────

export interface WorkflowSummary {
  id: string;
  label: string;
  isDefault: boolean;
  custom: boolean;
}

export interface WorkflowLibraryResponse {
  workflows: WorkflowSummary[];
  defaultWorkflow: string;
}

const EMPTY_LIBRARY: WorkflowLibraryResponse = {
  workflows: [{ id: DEFAULT_WORKFLOW_ID, label: 'Default', isDefault: true, custom: false }],
  defaultWorkflow: DEFAULT_WORKFLOW_ID,
};

let workflowsCache: WorkflowLibraryResponse | null = null;
let workflowsPromise: Promise<WorkflowLibraryResponse> | null = null;

function fetchWorkflows(): Promise<WorkflowLibraryResponse> {
  if (workflowsCache) return Promise.resolve(workflowsCache);
  if (workflowsPromise) return workflowsPromise;

  workflowsPromise = fetch('/api/config/workflows')
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<WorkflowLibraryResponse>;
    })
    .then((data) => {
      workflowsCache = data;
      workflowsPromise = null;
      return data;
    })
    .catch(() => {
      workflowsPromise = null;
      return EMPTY_LIBRARY;
    });

  return workflowsPromise;
}

export function useWorkflows(): WorkflowLibraryResponse {
  const [library, setLibrary] = useState<WorkflowLibraryResponse>(
    () => workflowsCache ?? EMPTY_LIBRARY,
  );

  useEffect(() => {
    let alive = true;
    fetchWorkflows().then((l) => {
      if (alive) setLibrary(l);
    });
    return () => {
      alive = false;
    };
  }, []);

  return library;
}

export function invalidateWorkflowsCache(): void {
  workflowsCache = null;
  workflowsPromise = null;
}
