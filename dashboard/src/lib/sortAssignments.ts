import type { SortField, SortDirection } from '@shared/view-prefs-schema';

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Sort a list of assignment-like records by the given field and direction.
 * Used by both `AssignmentsPage` and `ProjectDetail` so both surfaces share
 * a single sort implementation. Returns a new array — does not mutate input.
 */
export function sortAssignments<
  T extends {
    title: string;
    status: string;
    priority: string;
    assignee: string | null;
    dependsOn: string[];
    updated: string;
  },
>(items: T[], field: SortField, direction: SortDirection): T[] {
  const sorted = [...items].sort((a, b) => {
    let cmp = 0;
    switch (field) {
      case 'title':
        cmp = a.title.localeCompare(b.title);
        break;
      case 'status':
        cmp = a.status.localeCompare(b.status);
        break;
      case 'priority':
        cmp = (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99);
        break;
      case 'assignee':
        cmp = (a.assignee ?? '').localeCompare(b.assignee ?? '');
        break;
      case 'dependencies':
        cmp = a.dependsOn.length - b.dependsOn.length;
        break;
      case 'updated':
        cmp = a.updated.localeCompare(b.updated);
        break;
    }
    return direction === 'asc' ? cmp : -cmp;
  });
  return sorted;
}
