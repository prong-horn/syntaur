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

const DEFAULT_FILTERS: Required<ViewFilters> = {
  status: 'all',
  priority: 'all',
  assignee: 'all',
  project: 'all',
  activity: 'all',
  type: 'all',
};

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

// Strip default-equal filter values to keep the saved view minimal on disk.
// EXCEPT: never strip `project` if it came from `context.projectSlug` — that's
// load-bearing for re-landing on the right surface.
function minimizeFilters(filters: ViewFilters, forcedProject: string | null): ViewFilters {
  const minimal: ViewFilters = {};
  if (filters.status !== undefined && filters.status !== DEFAULT_FILTERS.status) {
    minimal.status = filters.status;
  }
  if (filters.priority !== undefined && filters.priority !== DEFAULT_FILTERS.priority) {
    minimal.priority = filters.priority;
  }
  if (filters.assignee !== undefined && filters.assignee !== DEFAULT_FILTERS.assignee) {
    minimal.assignee = filters.assignee;
  }
  if (filters.activity !== undefined && filters.activity !== DEFAULT_FILTERS.activity) {
    minimal.activity = filters.activity;
  }
  // Project is special-cased: forcedProject from context overrides any state value.
  if (forcedProject && forcedProject !== 'all') {
    minimal.project = forcedProject;
  } else if (filters.project !== undefined && filters.project !== DEFAULT_FILTERS.project) {
    minimal.project = filters.project;
  }
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
// Any setter not provided is a no-op for that field.
export interface ApplyConfigSetters {
  setViewMode?: (v: ViewMode) => void;
  setStatusFilter?: (v: string) => void;
  setPriorityFilter?: (v: string) => void;
  setAssigneeFilter?: (v: string) => void;
  setProjectFilter?: (v: string) => void;
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
  if (setters.setStatusFilter) setters.setStatusFilter(config.filters.status ?? 'all');
  if (setters.setPriorityFilter) setters.setPriorityFilter(config.filters.priority ?? 'all');
  if (setters.setAssigneeFilter) setters.setAssigneeFilter(config.filters.assignee ?? 'all');
  if (setters.setProjectFilter) setters.setProjectFilter(config.filters.project ?? 'all');
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
  const project = view.config.filters.project;
  // '__standalone__' is a sentinel meaning "items not in any project". It is
  // not a real project slug, so the right landing surface is the global
  // assignments list with the filter applied (not /projects/__standalone__).
  if (project && project !== 'all' && project !== '__standalone__') {
    // ProjectDetail defaults to the `overview` tab; explicitly target `assignments`
    // so the saved view actually applies to a visible board.
    return `${prefix}/projects/${project}?tab=assignments&loadView=${encodeURIComponent(view.id)}`;
  }
  return `${prefix}/assignments?loadView=${encodeURIComponent(view.id)}`;
}

// Canonical priority options for the create-view builder. There is no
// priority-config endpoint (unlike status/type), and AssignmentsPage derives its
// priority dropdown from live board items — not available on /views. This
// lowercase list is the canonical set; the saved value is whatever the user
// picks (or 'all', which minimizes away).
export const PRIORITY_OPTIONS = ['critical', 'high', 'medium', 'low'] as const;

// Builder state for the create-view dialog on /views. The dialog passes RAW
// state here — empty/whitespace free-text fields (e.g. assignee) are normalized
// by buildCreateViewPayload, NOT by the caller.
export interface CreateViewBuilderState {
  viewMode: ViewMode;
  filters: ViewFilters; // status / priority / assignee / project / activity
  sortField: SortField;
  sortDirection: SortDirection;
}

// Sensible defaults: kanban, no filters, sort by updated desc — so a user can
// create a near-default view in two clicks. All-default filters minimize to {}.
export const DEFAULT_CREATE_VIEW_STATE: CreateViewBuilderState = {
  viewMode: 'kanban',
  filters: {},
  sortField: 'updated',
  sortDirection: 'desc',
};

// Build the persistence payload (sans name) from builder state. SINGLE SOURCE OF
// TRUTH for normalization: an empty/whitespace assignee is cleaned to undefined
// here, because minimizeFilters only strips values equal to the 'all' default —
// a literal '' would otherwise persist and then filter to nothing on apply.
// Returns { workspace, config } (NOT name) so the create call cannot clobber the
// real name with an empty string.
export function buildCreateViewPayload(
  state: CreateViewBuilderState,
  workspace: string | null,
): { workspace: string | null; config: SavedViewConfig } {
  const assignee = state.filters.assignee?.trim();
  // A concrete project filter routes Apply to ProjectDetail (see
  // inferLandingRoute), which has NO activity filter and coerces 'list' to
  // 'kanban' (mirrors coerceProjectDetailView in view-prefs-schema). Drop
  // activity and coerce list here so the SAVED config faithfully matches what
  // Apply will actually render — otherwise the view would not round-trip. The
  // 'all'/'__standalone__' cases route to the global assignments list, which
  // supports both, so they keep activity + list.
  const project = state.filters.project;
  const concreteProject = !!project && project !== 'all' && project !== '__standalone__';
  const filters: ViewFilters = {
    ...state.filters,
    assignee: assignee ? assignee : undefined,
    activity: concreteProject ? undefined : state.filters.activity,
  };
  const viewMode: ViewMode =
    concreteProject && state.viewMode === 'list' ? 'kanban' : state.viewMode;
  const { config } = captureCurrentView({
    name: '',
    context: { workspace, projectSlug: null },
    state: {
      ...state,
      viewMode,
      filters,
      listSectionVisibility: { collapsed: [] },
      kanbanColumnVisibility: { hidden: [] },
      tableColumnVisibility: { hidden: [] },
    },
  });
  return { workspace, config };
}

// Human-readable summary of the non-default filters on a view, for /views rows.
export function summarizeFilters(filters: ViewFilters): string {
  const parts: string[] = [];
  for (const key of ['status', 'priority', 'assignee', 'project', 'activity'] as const) {
    const v = filters[key];
    if (!v || v === DEFAULT_FILTERS[key]) continue;
    parts.push(`${key}=${v}`);
  }
  return parts.join(' · ') || 'no filters';
}
