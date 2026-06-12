export type ViewMode = 'kanban' | 'list' | 'table';

export const VIEW_MODES: readonly ViewMode[] = ['kanban', 'list', 'table'];

export type SortField =
  | 'title'
  | 'status'
  | 'priority'
  | 'assignee'
  | 'dependencies'
  | 'created'
  | 'updated'
  | 'started'
  | 'lastActivity'
  | 'projectName'
  | 'agentName';

export const SORT_FIELDS: readonly SortField[] = [
  'title',
  'status',
  'priority',
  'assignee',
  'dependencies',
  'created',
  'updated',
  'started',
  'lastActivity',
  'projectName',
  'agentName',
];

// Sort fields offered by assignment-view surfaces (boards, CreateViewDialog,
// view defaults). The session-only fields are intentionally excluded so the
// assignment dropdowns don't surface session sorts.
export const ASSIGNMENT_SORT_FIELDS: readonly SortField[] = [
  'title',
  'status',
  'priority',
  'assignee',
  'dependencies',
  'created',
  'updated',
];

// Sort fields offered by session views (CreateSessionViewDialog).
export const SESSION_SORT_FIELDS: readonly SortField[] = [
  'started',
  'lastActivity',
  'projectName',
  'agentName',
];

export type SortDirection = 'asc' | 'desc';
export const SORT_DIRECTIONS: readonly SortDirection[] = ['asc', 'desc'];

export type Density = 'comfortable' | 'compact';
export const DENSITIES: readonly Density[] = ['comfortable', 'compact'];

export type Grouping = 'none' | 'status' | 'type' | 'priority' | 'assignee' | 'project';
export const GROUPINGS: readonly Grouping[] = [
  'none',
  'status',
  'type',
  'priority',
  'assignee',
  'project',
];

export type Activity = 'all' | 'stale' | 'fresh';
export const ACTIVITIES: readonly Activity[] = ['all', 'stale', 'fresh'];

// Date-range filter. `field` selects which timestamp to test. Either a relative
// `preset` (resolved against "now" at evaluation time, so a saved view stays
// relative) XOR an absolute `from`/`to` (YYYY-MM-DD, inclusive of the whole local
// `to` day). Absent/empty = no constraint. `dateRange` is a saved-view-only filter
// (never persisted to view-prefs).
export type DateRangeField = 'created' | 'updated' | 'started';
export const DATE_RANGE_FIELDS: readonly DateRangeField[] = ['created', 'updated', 'started'];

export type DateRangePreset =
  | 'last_24h' | 'last_7d' | 'last_30d' | 'last_90d' | 'older_7d' | 'older_30d';
export const DATE_RANGE_PRESETS: readonly DateRangePreset[] = [
  'last_24h', 'last_7d', 'last_30d', 'last_90d', 'older_7d', 'older_30d',
];

export interface DateRangeFilter {
  field: DateRangeField;
  preset?: DateRangePreset;
  from?: string; // YYYY-MM-DD
  to?: string; // YYYY-MM-DD
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateRangeField(v: unknown): v is DateRangeField {
  return typeof v === 'string' && (DATE_RANGE_FIELDS as readonly string[]).includes(v);
}
export function isDateRangePreset(v: unknown): v is DateRangePreset {
  return typeof v === 'string' && (DATE_RANGE_PRESETS as readonly string[]).includes(v);
}
// field required + valid; preset (if present) valid; from/to (if present) match
// YYYY-MM-DD; preset and from/to are mutually exclusive; reject unknown keys.
export function isDateRange(v: unknown): v is DateRangeFilter {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  if (!isDateRangeField(r.field)) return false;
  for (const key of Object.keys(r)) {
    if (key !== 'field' && key !== 'preset' && key !== 'from' && key !== 'to') return false;
  }
  const hasPreset = r.preset !== undefined;
  const hasAbsolute = r.from !== undefined || r.to !== undefined;
  if (hasPreset && hasAbsolute) return false;
  if (hasPreset && !isDateRangePreset(r.preset)) return false;
  if (r.from !== undefined && (typeof r.from !== 'string' || !YMD_RE.test(r.from))) return false;
  if (r.to !== undefined && (typeof r.to !== 'string' || !YMD_RE.test(r.to))) return false;
  return true;
}

// Filter values are user-data-driven strings (status ids, priority names,
// assignee names, project slugs) plus 'all'. The codebase also uses the
// sentinels '__unassigned__' and '__standalone__' for assignee/project,
// so validation is allow-by-shape (non-empty string), not allow-by-value.
//
// Multi-select: the multi-capable fields accept a single string (legacy /
// backward-compatible) OR an array of strings. `activity` stays a single
// tri-state enum. Normalize with `toFilterValues` before matching.
export type FilterValue = string | string[];

export interface ViewFilters {
  status?: FilterValue;
  type?: FilterValue;
  priority?: FilterValue;
  assignee?: FilterValue;
  project?: FilterValue;
  tags?: FilterValue;
  activity?: Activity;
  sessionStatus?: FilterValue;
  agent?: FilterValue;
  // Saved-view-only filters (never persisted to view-prefs):
  dateRange?: DateRangeFilter;
  search?: string;
  query?: string; // canonical AQL query string; chip-representable subset round-trips to the fields above
}

// Canonical normalization: any FilterValue -> deduped string[] of real
// constraints. `undefined` / `'all'` / `''` / `[]` / `['all']` all collapse to
// `[]` ("no constraint"). Trims, drops empty/'all', preserves first-seen order.
export function toFilterValues(v: FilterValue | undefined): string[] {
  const arr = v === undefined ? [] : Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const s of arr) {
    if (typeof s !== 'string') continue;
    const t = s.trim();
    if (!t || t === 'all') continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

// A FilterValue is a non-whitespace string, OR an array of non-whitespace
// strings (empty array allowed). Trim-gate here rather than relying on
// toFilterValues to erase whitespace after the fact.
export function isFilterValue(v: unknown): v is FilterValue {
  if (typeof v === 'string') return v.trim().length > 0;
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim().length > 0);
}

// Normalized set-equality for array filter state — used to gate React effects so
// switching board filter state to string[] doesn't thrash/loop on URL<->state sync.
export function sameFilterValues(a: FilterValue | undefined, b: FilterValue | undefined): boolean {
  const x = toFilterValues(a);
  const y = toFilterValues(b);
  return x.length === y.length && x.every((v) => y.includes(v));
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
    type: 'all',
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
