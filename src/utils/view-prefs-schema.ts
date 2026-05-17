export type ViewMode = 'kanban' | 'list' | 'table';

export const VIEW_MODES: readonly ViewMode[] = ['kanban', 'list', 'table'];

export type SortField =
  | 'title'
  | 'status'
  | 'priority'
  | 'assignee'
  | 'dependencies'
  | 'updated';

export const SORT_FIELDS: readonly SortField[] = [
  'title',
  'status',
  'priority',
  'assignee',
  'dependencies',
  'updated',
];

export type SortDirection = 'asc' | 'desc';
export const SORT_DIRECTIONS: readonly SortDirection[] = ['asc', 'desc'];

export type Density = 'comfortable' | 'compact';
export const DENSITIES: readonly Density[] = ['comfortable', 'compact'];

export type Grouping = 'none' | 'status' | 'priority' | 'assignee' | 'project';
export const GROUPINGS: readonly Grouping[] = [
  'none',
  'status',
  'priority',
  'assignee',
  'project',
];

export type Activity = 'all' | 'stale' | 'fresh';
export const ACTIVITIES: readonly Activity[] = ['all', 'stale', 'fresh'];

// Filter values are user-data-driven strings (status ids, priority names,
// assignee names, project slugs) plus 'all'. The codebase also uses the
// sentinels '__unassigned__' and '__standalone__' for assignee/project,
// so validation is allow-by-shape (non-empty string), not allow-by-value.
export interface ViewFilters {
  status?: string;
  priority?: string;
  assignee?: string;
  project?: string;
  activity?: Activity;
}

export interface ViewPrefs {
  defaultView: ViewMode;
  sortField: SortField;
  sortDirection: SortDirection;
  density: Density;
  grouping: Grouping;
  filters: ViewFilters;
}

// Per-scope overrides cannot set density (global only by product decision).
export type ProjectViewPrefs = Partial<Omit<ViewPrefs, 'density'>>;

export interface ViewPrefsFile {
  version: 1;
  global: ViewPrefs;
  projects: Record<string, ProjectViewPrefs>;
}

export const DEFAULT_VIEW_PREFS: ViewPrefs = {
  defaultView: 'kanban',
  sortField: 'updated',
  sortDirection: 'desc',
  density: 'comfortable',
  grouping: 'none',
  filters: {
    status: 'all',
    priority: 'all',
    assignee: 'all',
    project: 'all',
    activity: 'all',
  },
};

export const DEFAULT_VIEW_PREFS_FILE: ViewPrefsFile = {
  version: 1,
  global: DEFAULT_VIEW_PREFS,
  projects: {},
};

export function isViewMode(v: unknown): v is ViewMode {
  return typeof v === 'string' && (VIEW_MODES as readonly string[]).includes(v);
}

export function isSortField(v: unknown): v is SortField {
  return typeof v === 'string' && (SORT_FIELDS as readonly string[]).includes(v);
}

export function isSortDirection(v: unknown): v is SortDirection {
  return typeof v === 'string' && (SORT_DIRECTIONS as readonly string[]).includes(v);
}

export function isDensity(v: unknown): v is Density {
  return typeof v === 'string' && (DENSITIES as readonly string[]).includes(v);
}

export function isGrouping(v: unknown): v is Grouping {
  return typeof v === 'string' && (GROUPINGS as readonly string[]).includes(v);
}

export function isActivity(v: unknown): v is Activity {
  return typeof v === 'string' && (ACTIVITIES as readonly string[]).includes(v);
}

export function isFilterString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

// ProjectDetail only supports kanban/table; map 'list' onto 'kanban'.
export function coerceProjectDetailView(v: ViewMode): 'kanban' | 'table' {
  return v === 'table' ? 'table' : 'kanban';
}

function mergeFilters(base: ViewFilters, patch: ViewFilters | undefined): ViewFilters {
  if (!patch) return { ...base };
  return { ...base, ...patch };
}

function mergePrefs(base: ViewPrefs, patch: Partial<ViewPrefs> | undefined): ViewPrefs {
  if (!patch) return base;
  return {
    ...base,
    ...patch,
    filters: mergeFilters(base.filters, patch.filters),
  };
}

function mergeProjectOverride(
  base: ProjectViewPrefs,
  patch: ProjectViewPrefs | undefined,
): ProjectViewPrefs {
  if (!patch) return { ...base };
  return {
    ...base,
    ...patch,
    filters: patch.filters || base.filters
      ? mergeFilters(base.filters ?? {}, patch.filters)
      : undefined,
  };
}

// Returns the effective ViewPrefs for a scope. `scope === null` returns global.
// Density always comes from global (per the type constraint).
export function mergeForScope(file: ViewPrefsFile, scope: string | null): ViewPrefs {
  const global = file.global;
  if (scope === null) return global;
  const override = file.projects[scope];
  if (!override) return global;
  return {
    defaultView: override.defaultView ?? global.defaultView,
    sortField: override.sortField ?? global.sortField,
    sortDirection: override.sortDirection ?? global.sortDirection,
    density: global.density,
    grouping: override.grouping ?? global.grouping,
    filters: mergeFilters(global.filters, override.filters),
  };
}

// Canonical patch shape sent to POST /api/view-prefs.
export interface ViewPrefsPatch {
  global?: Partial<ViewPrefs>;
  projects?: Record<string, ProjectViewPrefs>;
}

// Deep-merges a patch into the current file. Does NOT validate; the route
// handler is expected to validate the result before persisting.
export function mergePatch(current: ViewPrefsFile, patch: ViewPrefsPatch): ViewPrefsFile {
  const nextProjects: Record<string, ProjectViewPrefs> = { ...current.projects };
  if (patch.projects) {
    for (const [scope, scopePatch] of Object.entries(patch.projects)) {
      const prev = nextProjects[scope] ?? {};
      nextProjects[scope] = mergeProjectOverride(prev, scopePatch);
    }
  }
  return {
    version: 1,
    global: mergePrefs(current.global, patch.global),
    projects: nextProjects,
  };
}
