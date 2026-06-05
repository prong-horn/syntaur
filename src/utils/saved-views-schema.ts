import {
  type ViewMode,
  type SortField,
  type SortDirection,
  type ViewFilters,
  type FilterValue,
  type DateRangeField,
  type DateRangeFilter,
  isViewMode,
  isSortField,
  isSortDirection,
  isActivity,
  isFilterValue,
  isDateRange,
  toFilterValues,
} from './view-prefs-schema.js';

// Re-export shared types so frontend can pull everything from a single module via `@shared/saved-views-schema`.
export type { ViewMode, SortField, SortDirection, ViewFilters, FilterValue, DateRangeField, DateRangeFilter };

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
  | 'created'
  | 'updated';

export const TABLE_COLUMN_IDS: readonly TableColumnId[] = [
  'title',
  'status',
  'priority',
  'assignee',
  'dependencies',
  'created',
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

// Per-slot sizing on the Overview dashboard. Two-axis named tiers: width
// (1 vs 2 columns at the `xl` breakpoint) × height (normal vs tall). The
// size→className mapping lives in the dashboard (Tailwind only scans
// `dashboard/`), not here. Absent `size` defaults to `small` at render.
export const WIDGET_SIZES = ['small', 'wide', 'tall', 'large'] as const;
export type WidgetSize = (typeof WIDGET_SIZES)[number];

export function isWidgetSize(value: unknown): value is WidgetSize {
  return typeof value === 'string' && (WIDGET_SIZES as readonly string[]).includes(value);
}

export interface DashboardSlot {
  id: string;
  widget: WidgetConfig | null;
  // Optional for backward compatibility: pre-sizing layouts have no `size` and
  // render at the `small` default. Validated by `isDashboardSlot`.
  size?: WidgetSize;
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

export function isViewFilters(value: unknown): value is ViewFilters {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  // Multi-capable fields accept a non-empty string OR an array of non-empty
  // strings (legacy single values still validate). `tags` joined the set.
  for (const key of ['status', 'type', 'priority', 'assignee', 'project', 'tags'] as const) {
    if (obj[key] !== undefined && !isFilterValue(obj[key])) return false;
  }
  if (obj.activity !== undefined && !isActivity(obj.activity)) return false;
  if (obj.dateRange !== undefined && !isDateRange(obj.dateRange)) return false;
  if (obj.search !== undefined && typeof obj.search !== 'string') return false;
  // Permissive about UNKNOWN keys (forward-compat): only known keys are validated.
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
  // Validate `size` BEFORE the null-widget early return, so an empty slot with
  // an invalid size (e.g. from a cascade-deleted view) is still rejected.
  if (obj.size !== undefined && !isWidgetSize(obj.size)) return false;
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

// Can ProjectDetail render this view faithfully? ProjectDetail pins the project
// to the URL slug and has NO activity setter, so a view is compatible only when
// its project set is empty or exactly [slug] AND it carries no active activity
// filter. `viewMode: 'list'` is fine — ProjectDetail intrinsically coerces it to
// kanban at apply time. This is the single source of truth shared by scopeMatches
// (picker visibility), inferLandingRoute (Apply target), and ProjectDetail's
// loadView guard, so they can never disagree.
export function isProjectDetailCompatible(config: SavedViewConfig, slug: string): boolean {
  const p = toFilterValues(config.filters.project);
  const projectOk = p.length === 0 || (p.length === 1 && p[0] === slug);
  const activity = config.filters.activity;
  // ProjectDetail has no activity or search controls (it DOES support tags +
  // date range). A view using either must route to the global list instead.
  const hasSearch = typeof config.filters.search === 'string' && config.filters.search.trim().length > 0;
  return projectOk && (!activity || activity === 'all') && !hasSearch;
}

// A view is compatible with a scope if it could meaningfully be applied there.
// - global: only global views (workspace === null) — global pages can't navigate to a workspace.
// - workspace: same-workspace views plus global views.
// - project: workspace must match (or be global) AND the config must be
//   ProjectDetail-renderable (empty/[slug] project set, no activity).
export function scopeMatches(view: SavedView, scope: ViewScope): boolean {
  switch (scope.kind) {
    case 'global':
      return view.workspace === null;
    case 'workspace':
      return view.workspace === scope.workspace || view.workspace === null;
    case 'project': {
      const workspaceOk = view.workspace === scope.workspace || view.workspace === null;
      if (!workspaceOk) return false;
      return isProjectDetailCompatible(view.config, scope.slug);
    }
  }
}
