/**
 * Chip-based filtering helpers retained for ProjectDetail's local assignment list.
 *
 * Board-level and saved-view widget AQL filtering now lives in
 * `dashboard/src/lib/queryFilter.ts` (`filterBoardItems`). AssignmentsPage and
 * SavedViewResults route all filtering through the shared AQL evaluator.
 * This module is NOT the source of truth for board/widget filtering — only for
 * ProjectDetail's chip-only local filter (`filterAssignment`).
 */
import { toFilterValues, type FilterValue, type DateRangeFilter } from '@shared/view-prefs-schema';
import type { AssignmentBoardItem } from '../hooks/useProjects';

// Structural minimum that `filterAssignment` reads. `AssignmentBoardItem`
// satisfies it fully; ProjectDetail's `AssignmentSummary` satisfies it too — the
// project / workspace / search-only fields are optional and only read when the
// matching criteria/options are set, which ProjectDetail never triggers.
export interface AssignmentFilterItem {
  status: string;
  priority: string;
  assignee: string | null;
  type?: string | null;
  tags?: string[];
  created?: string;
  updated: string;
  title?: string;
  slug?: string;
  projectSlug?: string | null;
  projectTitle?: string | null;
  projectWorkspace?: string | null;
  archived?: boolean;
}

// Multi-select: each field is a single value (legacy) or an array; `toFilterValues`
// normalizes to a deduped set where empty === "no constraint".
export interface AssignmentFilterCriteria {
  status?: FilterValue;
  priority?: FilterValue;
  type?: FilterValue;
  assignee?: FilterValue;
  project?: FilterValue;
  tags?: FilterValue;
  activity?: string;
  dateRange?: DateRangeFilter;
}

export interface AssignmentFilterOptions {
  workspace?: string | null;
  search?: string;
  /** Archived items are excluded from normal views by default; only the Archive page opts in. */
  includeArchived?: boolean;
}

export function isAssignmentStale(updated: string): boolean {
  const timestamp = Date.parse(updated);
  if (Number.isNaN(timestamp)) return false;
  return Date.now() - timestamp > 7 * 24 * 60 * 60 * 1000;
}

const PRESET_WINDOW_MS: Record<string, number> = {
  last_24h: 24 * 60 * 60 * 1000,
  last_7d: 7 * 24 * 60 * 60 * 1000,
  last_30d: 30 * 24 * 60 * 60 * 1000,
  last_90d: 90 * 24 * 60 * 60 * 1000,
  older_7d: 7 * 24 * 60 * 60 * 1000,
  older_30d: 30 * 24 * 60 * 60 * 1000,
};

// Local-day bounds for an absolute YYYY-MM-DD (the dashboard renders dates in
// LOCAL time, so a UTC-day bound would mis-exclude items near midnight).
function localDayStart(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}
function localDayEnd(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

// Does an item's created/updated timestamp satisfy a date-range filter? Parses
// timestamps and compares numerically (raw frontmatter ISO may be non-canonical).
// Relative presets resolve against `now`; absolute from/to are inclusive local days.
// `now` is injectable for tests; defaults to Date.now().
export function matchesDateRange(
  item: { created?: string; updated: string },
  range: DateRangeFilter | undefined,
  now: number = Date.now(),
): boolean {
  if (!range) return true;
  const raw = range.field === 'created' ? item.created ?? item.updated : item.updated;
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return false; // unparseable timestamp can't satisfy a date filter
  if (range.preset) {
    const win = PRESET_WINDOW_MS[range.preset];
    if (win === undefined) return true;
    if (range.preset.startsWith('older_')) return now - ts > win;
    return ts >= now - win && ts <= now; // last_*: within window AND not future-dated
  }
  const from = range.from && range.from.length > 0 ? range.from : undefined;
  const to = range.to && range.to.length > 0 ? range.to : undefined;
  if (!from && !to) return true;
  if (from && ts < localDayStart(from)) return false;
  if (to && ts > localDayEnd(to)) return false;
  return true;
}

// Mirrors AssignmentsPage's filter semantics exactly so saved-view widgets
// produce the same items as the source surface. Multi-value: an item matches a
// field when its value is in the selected set (OR within a field); fields are
// AND-ed; an empty set means "no constraint". Sentinels handled:
// - assignee '__unassigned__' matches items with assignee === null
// - project '__standalone__' matches items with projectSlug === null
// - workspace '_ungrouped' matches items with projectWorkspace === null
export function filterAssignment(
  item: AssignmentFilterItem,
  criteria: AssignmentFilterCriteria,
  options: AssignmentFilterOptions = {},
): boolean {
  const { workspace, search, includeArchived } = options;
  // Default-exclude archived from every normal view (defense-in-depth: ProjectDetail's
  // assignments come from getProjectDetail, which still includes archived items).
  if (item.archived === true && !includeArchived) return false;
  const statuses = toFilterValues(criteria.status);
  const priorities = toFilterValues(criteria.priority);
  const types = toFilterValues(criteria.type);
  const assignees = toFilterValues(criteria.assignee);
  const projects = toFilterValues(criteria.project);
  const tags = toFilterValues(criteria.tags);
  const { activity } = criteria;

  if (workspace) {
    if (workspace === '_ungrouped') {
      if (item.projectWorkspace != null) return false;
    } else if (item.projectWorkspace !== workspace) {
      return false;
    }
  }
  if (statuses.length && !statuses.includes(item.status)) return false;
  if (priorities.length && !priorities.includes(item.priority)) return false;
  if (types.length && !types.includes(item.type ?? '')) return false;
  if (activity === 'stale' && !isAssignmentStale(item.updated)) return false;
  if (activity === 'fresh' && isAssignmentStale(item.updated)) return false;
  if (assignees.length) {
    const val = item.assignee ?? '__unassigned__';
    if (!assignees.includes(val)) return false;
  }
  if (projects.length) {
    const matched = projects.some((p) =>
      p === '__standalone__' ? item.projectSlug == null : item.projectSlug === p,
    );
    if (!matched) return false;
  }
  // Tags: match-ANY (OR within the field) — item matches if it has any selected tag.
  if (tags.length) {
    const itemTags = item.tags ?? [];
    if (!tags.some((t) => itemTags.includes(t))) return false;
  }
  if (!matchesDateRange(item, criteria.dateRange)) return false;

  if (search) {
    const query = search.trim().toLowerCase();
    if (query) {
      const haystack = `${item.title ?? ''} ${item.slug ?? ''} ${item.projectTitle ?? 'standalone'} ${item.projectSlug ?? ''}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
  }

  return true;
}

// Per-item link prefix derivation. Used by both AssignmentsPage and
// dashboard widgets so workspace-scoped widgets on the global Overview
// produce correct deep links. Standalone items NEVER take a /w/<ws> prefix
// (no such route — see App.tsx).
export function assignmentDetailHref(item: AssignmentBoardItem): string {
  if (item.projectSlug === null) {
    return `/assignments/${item.id}`;
  }
  const prefix = item.projectWorkspace ? `/w/${item.projectWorkspace}` : '';
  return `${prefix}/projects/${item.projectSlug}/assignments/${item.slug}`;
}
