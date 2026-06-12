import type {
  SavedView,
  ViewFilters,
  ViewMode,
  SortField,
  SortDirection,
  ListSectionVisibility,
  KanbanColumnVisibility,
  TableColumnVisibility,
} from '@shared/saved-views-schema';
import { isProjectDetailCompatible } from '@shared/saved-views-schema';
import { toFilterValues, type DateRangeFilter, type DateRangeField } from '@shared/view-prefs-schema';
import { viewFiltersToQuery, queryToViewFilters } from '@shared/view-filters-query';

// The config build/minimize/merge helpers now live in a Node-safe shared module
// (`src/utils/saved-view-builder.ts`) so the `syntaur views` CLI and this
// dashboard lib produce byte-identical `config` shapes. Re-exported here to keep
// this module's public surface unchanged for existing importers/tests.
export {
  preserveUnknownFilterKeys,
  mergeUpdatedConfig,
  captureCurrentView,
  DEFAULT_CREATE_VIEW_STATE,
  buildCreateViewPayload,
  DEFAULT_CREATE_SESSION_VIEW_STATE,
  buildSessionViewPayload,
} from '@shared/saved-view-builder';
export type {
  CaptureContext,
  CaptureInput,
  CapturedPayload,
  CreateViewBuilderState,
  CreateSessionViewBuilderState,
} from '@shared/saved-view-builder';

// ── Date-range UI <-> persisted shape ───────────────────────────────────────
// The control keeps `preset`/`from`/`to` as always-strings ('' = none) so React
// treats them as controlled values; `null` = "no date filter".
export interface DateRangeUiState {
  field: DateRangeField;
  preset: string; // DateRangePreset | ''
  from: string; // YYYY-MM-DD | ''
  to: string; // YYYY-MM-DD | ''
}

// Capture-side: UI state -> persisted DateRangeFilter (or undefined if inactive).
// preset takes precedence over absolute from/to.
export function minimizeDateRange(ui: DateRangeUiState | null): DateRangeFilter | undefined {
  if (!ui) return undefined;
  if (ui.preset) return { field: ui.field, preset: ui.preset as DateRangeFilter['preset'] };
  const from = ui.from && ui.from.length > 0 ? ui.from : undefined;
  const to = ui.to && ui.to.length > 0 ? ui.to : undefined;
  if (!from && !to) return undefined;
  const out: DateRangeFilter = { field: ui.field };
  if (from) out.from = from;
  if (to) out.to = to;
  return out;
}

// Apply-side: persisted -> UI state (null when absent).
export function expandDateRange(persisted: DateRangeFilter | undefined): DateRangeUiState | null {
  if (!persisted) return null;
  return {
    field: persisted.field,
    preset: persisted.preset ?? '',
    from: persisted.from ?? '',
    to: persisted.to ?? '',
  };
}

// Bag of optional setters. A surface page passes only the setters it owns.
// Any setter not provided is a no-op for that field. Multi-value fields receive
// a normalized string[] ([] === "no constraint").
export interface ApplyConfigSetters {
  setViewMode?: (v: ViewMode) => void;
  setStatusFilter?: (v: string[]) => void;
  setTypeFilter?: (v: string[]) => void;
  setPriorityFilter?: (v: string[]) => void;
  setAssigneeFilter?: (v: string[]) => void;
  setProjectFilter?: (v: string[]) => void;
  setTagsFilter?: (v: string[]) => void;
  setActivityFilter?: (v: 'all' | 'stale' | 'fresh') => void;
  setDateRange?: (v: DateRangeUiState | null) => void;
  setSearch?: (v: string) => void;
  /** Canonical AQL query. Receives the view's stored `query` or, for legacy
   * views without one, a query synthesized from the chip filters (lossless
   * upgrade). Surfaces that own a query state (AssignmentsPage) pass this. */
  setQuery?: (v: string) => void;
  setSortField?: (v: SortField) => void;
  setSortDirection?: (v: SortDirection) => void;
  setListSectionVisibility?: (v: ListSectionVisibility) => void;
  setKanbanColumnVisibility?: (v: KanbanColumnVisibility) => void;
  setTableColumnVisibility?: (v: TableColumnVisibility) => void;
}

export function applyConfig(view: SavedView, setters: ApplyConfigSetters): void {
  const { config } = view;
  setters.setViewMode?.(config.viewMode);
  setters.setStatusFilter?.(toFilterValues(config.filters.status));
  setters.setTypeFilter?.(toFilterValues(config.filters.type));
  setters.setPriorityFilter?.(toFilterValues(config.filters.priority));
  setters.setAssigneeFilter?.(toFilterValues(config.filters.assignee));
  setters.setProjectFilter?.(toFilterValues(config.filters.project));
  setters.setTagsFilter?.(toFilterValues(config.filters.tags));
  setters.setDateRange?.(expandDateRange(config.filters.dateRange));
  setters.setSearch?.(config.filters.search ?? '');
  // Lossless upgrade: the effective query is the stored canonical `query` when
  // present, else one synthesized from the chip filters (old views without a
  // query round-trip their chips into one). The chip setters above still apply
  // the legacy keys so a chip-representable view drives both the chips and the
  // query identically.
  setters.setQuery?.(config.filters.query ?? viewFiltersToQuery(config.filters));
  if (setters.setActivityFilter) {
    const a = config.filters.activity ?? 'all';
    setters.setActivityFilter(a === 'fresh' || a === 'stale' ? a : 'all');
  }
  setters.setSortField?.(config.sortField);
  setters.setSortDirection?.(config.sortDirection);
  setters.setListSectionVisibility?.({ collapsed: [...config.listSectionVisibility.collapsed] });
  setters.setKanbanColumnVisibility?.({ hidden: [...config.kanbanColumnVisibility.hidden] });
  setters.setTableColumnVisibility?.({ hidden: [...config.tableColumnVisibility.hidden] });
}

// The saved-views LIST route for a scope. A workspace-scoped view's chrome lives
// under /w/<ws>/views, a global view's under /views.
export function savedViewsIndexPath(workspace: string | null): string {
  return workspace ? `/w/${workspace}/views` : '/views';
}

// The detail-page route for a saved view. Keyed off the VIEW's OWN workspace (not
// the current route), so /w/<ws>/views/<id> always matches the view's scope.
export function savedViewPath(view: Pick<SavedView, 'id' | 'workspace'>): string {
  return `${savedViewsIndexPath(view.workspace)}/${encodeURIComponent(view.id)}`;
}

// Routing helper for the "Open on board" action and dashboard widget link
// generation. The view's own `workspace` field drives the prefix; the caller's
// current workspace is irrelevant — opening a workspace-scoped view on a board
// should navigate to that workspace, not stay where you are. (Since the view-detail
// redesign, this is the secondary "Open on board" path, not the default /views action.)
export function inferLandingRoute(view: SavedView): string {
  const prefix = view.workspace ? `/w/${view.workspace}` : '';
  const projects = toFilterValues(view.config.filters.project);
  // Route to a single project's board ONLY when the view is ProjectDetail-renderable
  // (exactly one concrete project, no activity filter — ProjectDetail has none).
  // Everything else (multi-project, '__standalone__', or single-project + activity)
  // goes to the global assignments list, which renders project + activity faithfully.
  if (
    projects.length === 1 &&
    projects[0] !== '__standalone__' &&
    isProjectDetailCompatible(view.config, projects[0])
  ) {
    // ProjectDetail defaults to the `overview` tab; explicitly target `assignments`
    // so the saved view actually applies to a visible board.
    return `${prefix}/projects/${projects[0]}?tab=assignments&loadView=${encodeURIComponent(view.id)}`;
  }
  return `${prefix}/assignments?loadView=${encodeURIComponent(view.id)}`;
}

// Canonical priority options for the create-view builder. There is no
// priority-config endpoint (unlike status/type), and AssignmentsPage derives its
// priority dropdown from live board items — not available on /views. This
// lowercase list is the canonical set; saved values are whatever the user picks.
export const PRIORITY_OPTIONS = ['critical', 'high', 'medium', 'low'] as const;

// Human-readable summary of the non-default filters on a view, for /views rows.
// Multi-value fields render their members joined: `status=in_progress, review`.
const DATE_PRESET_LABEL: Record<string, string> = {
  last_24h: 'last 24 hours',
  last_7d: 'last 7 days',
  last_30d: 'last 30 days',
  last_90d: 'last 90 days',
  older_7d: 'older than 7 days',
  older_30d: 'older than 30 days',
};

function summarizeDateRange(dr: DateRangeFilter): string {
  if (dr.preset) return `${dr.field} ${DATE_PRESET_LABEL[dr.preset] ?? dr.preset}`;
  const from = dr.from ?? '…';
  const to = dr.to ?? '…';
  return `${dr.field} ${from}→${to}`;
}

export function summarizeFilters(filters: ViewFilters): string {
  // A non-chip-representable query owns the filter: the legacy chip keys can't
  // express it, so summarize the raw query string instead of the (absent) chips.
  const query = filters.query?.trim();
  if (query && queryToViewFilters(query) === null) {
    return `query: ${query}`;
  }
  const parts: string[] = [];
  for (const key of ['status', 'priority', 'type', 'assignee', 'project', 'tags'] as const) {
    const vals = toFilterValues(filters[key]);
    if (vals.length) parts.push(`${key}=${vals.join(', ')}`);
  }
  if (filters.activity && filters.activity !== 'all') parts.push(`activity=${filters.activity}`);
  if (filters.dateRange) parts.push(summarizeDateRange(filters.dateRange));
  const search = filters.search?.trim();
  if (search) parts.push(`search="${search}"`);
  return parts.join(' · ') || 'no filters';
}
