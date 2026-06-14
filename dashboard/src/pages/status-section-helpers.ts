import type { StatusConfigResponse } from '../hooks/useStatusConfig';
import { sortStatusesByOrder } from './settings-page-helpers';

export interface EditableStatus {
  rowKey: string;
  id: string;
  label: string;
  description: string;
  color: string;
  terminal: boolean;
}

export function makeRowKey(): string {
  return `row_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

// Hydrate the merged Status Definitions list. `statuses` array order IS the
// display order, so we sort the rows by the persisted `config.order` (the
// order consumed by Kanban columns, progress bars, and dropdowns). There is no
// separate `order` state — save derives it back via statuses.map(s => s.id).
export function toEditable(config: StatusConfigResponse): EditableStatus[] {
  const rows = config.statuses.map((s) => ({
    rowKey: makeRowKey(),
    id: s.id,
    label: s.label,
    description: s.description ?? '',
    color: s.color ?? '',
    terminal: s.terminal ?? false,
  }));
  return sortStatusesByOrder(rows, config.order);
}
