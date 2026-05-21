import {
  type ViewMode,
  type SortField,
  type SortDirection,
  type ViewFilters,
  isViewMode,
  isSortField,
  isSortDirection,
} from './view-prefs-schema.js';

// Re-export shared types so frontend can pull everything from a single module via `@shared/saved-views-schema`.
export type { ViewMode, SortField, SortDirection, ViewFilters };

export interface ListSectionVisibility {
  collapsed: string[];
}

export interface KanbanColumnVisibility {
  hidden: string[];
}

export type TableColumnId =
  | 'title'
  | 'status'
  | 'priority'
  | 'assignee'
  | 'dependencies'
  | 'updated';

export const TABLE_COLUMN_IDS: readonly TableColumnId[] = [
  'title',
  'status',
  'priority',
  'assignee',
  'dependencies',
  'updated',
];

export function isTableColumnId(value: unknown): value is TableColumnId {
  return typeof value === 'string' && (TABLE_COLUMN_IDS as readonly string[]).includes(value);
}

export interface TableColumnVisibility {
  hidden: TableColumnId[];
}

export interface SavedViewConfig {
  viewMode: ViewMode;
  filters: ViewFilters;
  sortField: SortField;
  sortDirection: SortDirection;
  listSectionVisibility: ListSectionVisibility;
  kanbanColumnVisibility: KanbanColumnVisibility;
  tableColumnVisibility: TableColumnVisibility;
}

export interface SavedView {
  id: string;
  name: string;
  workspace: string | null;
  config: SavedViewConfig;
  createdAt: string;
  updatedAt: string;
}

export type WidgetConfig =
  | { kind: 'saved-view'; viewId: string }
  | { kind: 'agent-sessions' }
  | { kind: 'inventories' };

export const WIDGET_KINDS = ['saved-view', 'agent-sessions', 'inventories'] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

export interface DashboardSlot {
  id: string;
  widget: WidgetConfig | null;
}

export interface DashboardLayout {
  version: 1;
  slots: DashboardSlot[];
}

export const DEFAULT_SLOT_COUNT = 5;

export interface SavedViewsFile {
  version: 1;
  views: SavedView[];
  dashboard: DashboardLayout;
}

const DEFAULT_FILTERS: ViewFilters = {
  status: 'all',
  priority: 'all',
  assignee: 'all',
  project: 'all',
  activity: 'all',
};

const SEED_TIMESTAMP = '2026-05-21T00:00:00Z';

function makeSeededView(
  id: string,
  name: string,
  filterOverrides: Partial<ViewFilters>,
): SavedView {
  return {
    id,
    name,
    workspace: null,
    config: {
      viewMode: 'list',
      filters: { ...DEFAULT_FILTERS, ...filterOverrides },
      sortField: 'updated',
      sortDirection: 'desc',
      listSectionVisibility: { collapsed: [] },
      kanbanColumnVisibility: { hidden: [] },
      tableColumnVisibility: { hidden: [] },
    },
    createdAt: SEED_TIMESTAMP,
    updatedAt: SEED_TIMESTAMP,
  };
}

// Status-agnostic defaults (Decision 13) so first-run works regardless of the user's status configuration.
export const DEFAULT_SAVED_VIEWS_FILE: SavedViewsFile = {
  version: 1,
  views: [
    makeSeededView('default-recently-updated', 'Recently updated', {}),
    makeSeededView('default-high-priority', 'High priority', { priority: 'high' }),
    makeSeededView('default-stale', 'Stale', { activity: 'stale' }),
  ],
  dashboard: {
    version: 1,
    slots: [
      { id: 'slot-0', widget: { kind: 'agent-sessions' } },
      { id: 'slot-1', widget: { kind: 'saved-view', viewId: 'default-recently-updated' } },
      { id: 'slot-2', widget: { kind: 'saved-view', viewId: 'default-high-priority' } },
      { id: 'slot-3', widget: { kind: 'saved-view', viewId: 'default-stale' } },
      { id: 'slot-4', widget: { kind: 'inventories' } },
    ],
  },
};

export function isWidgetConfig(value: unknown): value is WidgetConfig {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (obj.kind === 'saved-view') {
    return typeof obj.viewId === 'string' && obj.viewId.length > 0;
  }
  return obj.kind === 'agent-sessions' || obj.kind === 'inventories';
}

function isListSectionVisibility(value: unknown): value is ListSectionVisibility {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj.collapsed) && obj.collapsed.every((s) => typeof s === 'string');
}

function isKanbanColumnVisibility(value: unknown): value is KanbanColumnVisibility {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj.hidden) && obj.hidden.every((s) => typeof s === 'string');
}

function isTableColumnVisibility(value: unknown): value is TableColumnVisibility {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj.hidden) && obj.hidden.every((s) => isTableColumnId(s));
}

function isViewFilters(value: unknown): value is ViewFilters {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  for (const key of ['status', 'priority', 'assignee', 'project', 'activity']) {
    const v = obj[key];
    if (v !== undefined && typeof v !== 'string') return false;
  }
  return true;
}

export function isSavedViewConfig(value: unknown): value is SavedViewConfig {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    isViewMode(obj.viewMode) &&
    isViewFilters(obj.filters) &&
    isSortField(obj.sortField) &&
    isSortDirection(obj.sortDirection) &&
    isListSectionVisibility(obj.listSectionVisibility) &&
    isKanbanColumnVisibility(obj.kanbanColumnVisibility) &&
    isTableColumnVisibility(obj.tableColumnVisibility)
  );
}

export function isSavedView(value: unknown): value is SavedView {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    obj.id.length > 0 &&
    typeof obj.name === 'string' &&
    (obj.workspace === null || typeof obj.workspace === 'string') &&
    isSavedViewConfig(obj.config) &&
    typeof obj.createdAt === 'string' &&
    typeof obj.updatedAt === 'string'
  );
}

export function isDashboardSlot(value: unknown): value is DashboardSlot {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id.length === 0) return false;
  if (obj.widget === null) return true;
  return isWidgetConfig(obj.widget);
}

export function isDashboardLayout(value: unknown): value is DashboardLayout {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1) return false;
  return Array.isArray(obj.slots) && obj.slots.every(isDashboardSlot);
}

export type ViewScope =
  | { kind: 'global' }
  | { kind: 'workspace'; workspace: string }
  | { kind: 'project'; slug: string; workspace: string | null };

// A view is compatible with a scope if it could meaningfully be applied there.
// - global: only global views (workspace === null) — global pages can't navigate to a workspace.
// - workspace: same-workspace views plus global views.
// - project: workspace must match (or be global) AND projectFilter must be undefined/'all'/matching slug.
export function scopeMatches(view: SavedView, scope: ViewScope): boolean {
  switch (scope.kind) {
    case 'global':
      return view.workspace === null;
    case 'workspace':
      return view.workspace === scope.workspace || view.workspace === null;
    case 'project': {
      const workspaceOk = view.workspace === scope.workspace || view.workspace === null;
      if (!workspaceOk) return false;
      const viewProject = view.config.filters.project;
      return viewProject === undefined || viewProject === 'all' || viewProject === scope.slug;
    }
  }
}
