import { useMemo } from 'react';

export interface StatusDefinition {
  id: string;
  label: string;
  description?: string;
  color?: string;
  icon?: string;
  terminal?: boolean;
}

/** Fixed v2 stage table — single source for board columns and status pickers. */
export const STAGE_TABLE: StatusDefinition[] = [
  { id: 'backlog', label: 'Backlog', color: 'slate' },
  { id: 'planning', label: 'Planning', color: 'violet' },
  { id: 'ready', label: 'Ready', color: 'blue' },
  { id: 'in_progress', label: 'In Progress', color: 'teal' },
  { id: 'review', label: 'Review', color: 'amber' },
  { id: 'done', label: 'Done', color: 'emerald', terminal: true },
  { id: 'dropped', label: 'Dropped', color: 'rose', terminal: true },
];

export const STAGE_ORDER = STAGE_TABLE.map((s) => s.id);

export interface StatusConfigResponse {
  statuses: StatusDefinition[];
  order: string[];
}

const STATUS_CONFIG: StatusConfigResponse = {
  statuses: STAGE_TABLE,
  order: STAGE_ORDER,
};

export function useStatusConfig(): StatusConfigResponse {
  return useMemo(() => STATUS_CONFIG, []);
}

export function getStatusLabel(config: StatusConfigResponse, statusId: string): string {
  const found = config.statuses.find((s) => s.id === statusId);
  return found?.label ?? statusId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function invalidateStatusConfigCache(): void {
  /* fixed stage table — no cache */
}
