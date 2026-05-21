import type { AssignmentBoardItem } from '../hooks/useProjects';

export interface AssignmentFilterCriteria {
  status?: string;
  priority?: string;
  assignee?: string;
  project?: string;
  activity?: string;
}

export interface AssignmentFilterOptions {
  workspace?: string | null;
  search?: string;
}

export function isAssignmentStale(updated: string): boolean {
  const timestamp = Date.parse(updated);
  if (Number.isNaN(timestamp)) return false;
  return Date.now() - timestamp > 7 * 24 * 60 * 60 * 1000;
}

// Mirrors AssignmentsPage's filter semantics exactly so saved-view widgets
// produce the same items as the source surface. Sentinels handled:
// - assignee '__unassigned__' matches items with assignee === null
// - project '__standalone__' matches items with projectSlug === null
// - workspace '_ungrouped' matches items with projectWorkspace === null
export function filterAssignment(
  item: AssignmentBoardItem,
  criteria: AssignmentFilterCriteria,
  options: AssignmentFilterOptions = {},
): boolean {
  const { workspace, search } = options;
  const { status, priority, assignee, project, activity } = criteria;

  if (workspace) {
    if (workspace === '_ungrouped') {
      if (item.projectWorkspace !== null) return false;
    } else {
      if (item.projectWorkspace !== workspace) return false;
    }
  }
  if (status && status !== 'all' && item.status !== status) return false;
  if (priority && priority !== 'all' && item.priority !== priority) return false;
  if (activity === 'stale' && !isAssignmentStale(item.updated)) return false;
  if (activity === 'fresh' && isAssignmentStale(item.updated)) return false;
  if (assignee && assignee !== 'all') {
    const val = item.assignee ?? '__unassigned__';
    if (val !== assignee) return false;
  }
  if (project && project !== 'all') {
    if (project === '__standalone__') {
      if (item.projectSlug !== null) return false;
    } else if (item.projectSlug !== project) {
      return false;
    }
  }

  if (search) {
    const query = search.trim().toLowerCase();
    if (query) {
      const haystack = `${item.title} ${item.slug} ${item.projectTitle ?? 'standalone'} ${item.projectSlug ?? ''}`.toLowerCase();
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
