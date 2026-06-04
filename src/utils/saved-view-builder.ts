// Shared, Node-safe builder/minimizer/merger for saved-view `config` objects.
//
// This is the single source of truth for how a SavedViewConfig is assembled,
// minimized, and merged on update. It is imported by BOTH the dashboard
// (`dashboard/src/lib/savedViews.ts` re-exports these, via the `@shared/*`
// alias) and the `syntaur views` CLI (`src/commands/views.ts`, relative import),
// so a CLI-created view's serialized `config` matches a UI-created one exactly.
//
// No DOM/React/browser dependencies — only plain schema types + `toFilterValues`.

import type {
  SavedViewConfig,
  ViewFilters,
  ViewMode,
  SortField,
  SortDirection,
  ListSectionVisibility,
  KanbanColumnVisibility,
  TableColumnVisibility,
} from './saved-views-schema.js';
import { toFilterValues } from './view-prefs-schema.js';

// Known saved-view filter keys. Used to preserve forward-compat UNKNOWN keys when
// rebuilding `filters` on any update path (so a future filter key isn't dropped).
export const KNOWN_FILTER_KEYS = new Set([
  'status', 'type', 'priority', 'assignee', 'project', 'tags', 'activity', 'dateRange', 'search',
]);

export function preserveUnknownFilterKeys(existing: ViewFilters, built: ViewFilters): ViewFilters {
  const out: ViewFilters = {};
  for (const [k, v] of Object.entries(existing)) {
    if (!KNOWN_FILTER_KEYS.has(k)) (out as Record<string, unknown>)[k] = v;
  }
  return { ...out, ...built };
}

// The single config-merge helper for EVERY saved-view UPDATE path. Rebuilds known
// fields from `built`, preserves unknown top-level + filter keys from `existing`,
// and takes the three visibility objects from `visibility` (live board capture for
// board Update; the existing view for the /views edit dialog or the CLI).
export function mergeUpdatedConfig(
  existing: SavedViewConfig,
  built: SavedViewConfig,
  visibility: Pick<
    SavedViewConfig,
    'listSectionVisibility' | 'kanbanColumnVisibility' | 'tableColumnVisibility'
  >,
): SavedViewConfig {
  return {
    ...existing,
    viewMode: built.viewMode,
    filters: preserveUnknownFilterKeys(existing.filters, built.filters),
    sortField: built.sortField,
    sortDirection: built.sortDirection,
    listSectionVisibility: { collapsed: [...visibility.listSectionVisibility.collapsed] },
    kanbanColumnVisibility: { hidden: [...visibility.kanbanColumnVisibility.hidden] },
    tableColumnVisibility: { hidden: [...visibility.tableColumnVisibility.hidden] },
  };
}

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
// right surface.
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
  const tags = toFilterValues(filters.tags);
  if (tags.length) minimal.tags = tags;
  // Project is special-cased: forcedProject from context overrides any state value.
  if (forcedProject && forcedProject !== 'all') {
    minimal.project = [forcedProject];
  } else {
    const project = toFilterValues(filters.project);
    if (project.length) minimal.project = project;
  }
  if (filters.activity && filters.activity !== 'all') minimal.activity = filters.activity;
  // dateRange is already minimized (built directly from validated inputs).
  if (filters.dateRange) minimal.dateRange = filters.dateRange;
  const search = filters.search?.trim();
  if (search) minimal.search = search;
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

// Builder state for the create-view dialog on /views. Multi-value fields are
// string[] ([] === unset). Normalization (trim/dedupe/drop-empty) happens in
// minimizeFilters via captureCurrentView, so callers pass RAW arrays.
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
// name with an empty string.
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
