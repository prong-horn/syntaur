import { toFilterValues, type FilterValue } from '@shared/view-prefs-schema';
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
  activity?: string;
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
