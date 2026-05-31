import type {
  SavedView,
  SavedViewConfig,
  ViewFilters,
  ViewMode,
  SortField,
  SortDirection,
  ListSectionVisibility,
  KanbanColumnVisibility,
  TableColumnVisibility,
} from '@shared/saved-views-schema';
import { isProjectDetailCompatible } from '@shared/saved-views-schema';
import { toFilterValues } from '@shared/view-prefs-schema';

export interface CaptureContext {
  workspace: string | null;
  /** When set, overrides `state.filters.project` — used by ProjectDetail where the slug is URL-derived. */
  projectSlug: string | null;
}

export interface CaptureInput {
  name: string;
  context: CaptureContext;
  state: {
    viewMode: ViewMode;
    filters: ViewFilters;
    sortField: SortField;
    sortDirection: SortDirection;
    listSectionVisibility: ListSectionVisibility;
    kanbanColumnVisibility: KanbanColumnVisibility;
    tableColumnVisibility: TableColumnVisibility;
  };
}

export interface CapturedPayload {
  name: string;
  workspace: string | null;
  config: SavedViewConfig;
}

// Strip default-equal / empty filter values to keep the saved view minimal on
// disk. Multi-value fields persist as arrays (single-element arrays included);
// `toFilterValues` drops 'all'/empty/dupes. EXCEPT: never strip `project` if it
// came from `context.projectSlug` — that's load-bearing for re-landing on the
// right surface. NOTE: no route-capability coercion happens here (Decision 11) —
// captured configs are faithful; `inferLandingRoute` + ProjectDetail's
// apply-time view coercion handle surface compatibility.
function minimizeFilters(filters: ViewFilters, forcedProject: string | null): ViewFilters {
  const minimal: ViewFilters = {};
  const status = toFilterValues(filters.status);
  if (status.length) minimal.status = status;
  const type = toFilterValues(filters.type);
  if (type.length) minimal.type = type;
  const priority = toFilterValues(filters.priority);
  if (priority.length) minimal.priority = priority;
  const assignee = toFilterValues(filters.assignee);
  if (assignee.length) minimal.assignee = assignee;
  // Project is special-cased: forcedProject from context overrides any state value.
  if (forcedProject && forcedProject !== 'all') {
    minimal.project = [forcedProject];
  } else {
    const project = toFilterValues(filters.project);
    if (project.length) minimal.project = project;
  }
  if (filters.activity && filters.activity !== 'all') minimal.activity = filters.activity;
  return minimal;
}

export function captureCurrentView(input: CaptureInput): CapturedPayload {
  const config: SavedViewConfig = {
    viewMode: input.state.viewMode,
    filters: minimizeFilters(input.state.filters, input.context.projectSlug),
    sortField: input.state.sortField,
    sortDirection: input.state.sortDirection,
    listSectionVisibility: { collapsed: [...input.state.listSectionVisibility.collapsed] },
    kanbanColumnVisibility: { hidden: [...input.state.kanbanColumnVisibility.hidden] },
    tableColumnVisibility: { hidden: [...input.state.tableColumnVisibility.hidden] },
  };
  return {
    name: input.name.trim(),
    workspace: input.context.workspace,
    config,
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
  setActivityFilter?: (v: 'all' | 'stale' | 'fresh') => void;
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

// Routing helper for /views Apply button and dashboard widget link generation.
// The view's own `workspace` field drives the prefix; the caller's current
// workspace is irrelevant — applying a workspace-scoped view should navigate
// to that workspace, not stay where you are.
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

// Builder state for the create-view dialog on /views. Multi-value fields are
// string[] ([] === unset). Normalization (trim/dedupe/drop-empty) happens in
// minimizeFilters via captureCurrentView, so the dialog passes RAW arrays.
export interface CreateViewBuilderState {
  viewMode: ViewMode;
  filters: ViewFilters; // status / type / priority / assignee / project (arrays) + activity
  sortField: SortField;
  sortDirection: SortDirection;
}

// Sensible defaults: kanban, no filters, sort by updated desc — so a user can
// create a near-default view in two clicks. All-empty filters minimize to {}.
export const DEFAULT_CREATE_VIEW_STATE: CreateViewBuilderState = {
  viewMode: 'kanban',
  filters: {},
  sortField: 'updated',
  sortDirection: 'desc',
};

// Build the persistence payload (sans name) from builder state. Returns
// { workspace, config } (NOT name) so the create call cannot clobber the real
// name with an empty string. No route coercion (Decision 11) — captureCurrentView
// persists faithfully; routing handles surface compatibility.
export function buildCreateViewPayload(
  state: CreateViewBuilderState,
  workspace: string | null,
): { workspace: string | null; config: SavedViewConfig } {
  const { config } = captureCurrentView({
    name: '',
    context: { workspace, projectSlug: null },
    state: {
      viewMode: state.viewMode,
      filters: state.filters,
      sortField: state.sortField,
      sortDirection: state.sortDirection,
      listSectionVisibility: { collapsed: [] },
      kanbanColumnVisibility: { hidden: [] },
      tableColumnVisibility: { hidden: [] },
    },
  });
  return { workspace, config };
}

// Human-readable summary of the non-default filters on a view, for /views rows.
// Multi-value fields render their members joined: `status=in_progress, review`.
export function summarizeFilters(filters: ViewFilters): string {
  const parts: string[] = [];
  for (const key of ['status', 'priority', 'type', 'assignee', 'project'] as const) {
    const vals = toFilterValues(filters[key]);
    if (vals.length) parts.push(`${key}=${vals.join(', ')}`);
  }
  if (filters.activity && filters.activity !== 'all') parts.push(`activity=${filters.activity}`);
  return parts.join(' · ') || 'no filters';
}
