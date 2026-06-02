import type { TodoStatus } from '../todos/types.js';

// Shared, framework-free definitions for the accordion-grouped todos views.
// Lives in src/utils (imported by the dashboard via the `@shared/todo-sections`
// alias) so the pure grouping logic can be unit-tested under root `npm test`.

export type TodoSectionId = 'open-blocked' | 'in-progress' | 'done';

export interface TodoSectionConfig {
  id: TodoSectionId;
  /** Header label shown in the accordion. */
  label: string;
  /** Statuses that belong in this section. */
  statuses: TodoStatus[];
  /** Status applied when a todo is dragged INTO this section from another. */
  dropStatus: TodoStatus;
  /** Whether the section starts collapsed when no persisted preference exists. */
  defaultCollapsed: boolean;
}

// Order here is the render order of the accordion.
export const TODO_SECTIONS: TodoSectionConfig[] = [
  {
    id: 'open-blocked',
    label: 'Open / Blocked',
    statuses: ['open', 'blocked'],
    dropStatus: 'open',
    defaultCollapsed: false,
  },
  {
    id: 'in-progress',
    label: 'In Progress',
    statuses: ['in_progress'],
    dropStatus: 'in_progress',
    defaultCollapsed: false,
  },
  {
    id: 'done',
    label: 'Done',
    statuses: ['completed'],
    dropStatus: 'completed',
    defaultCollapsed: true,
  },
];

// Maps a todo status to the section it renders in. `blocked` joins `open`.
export function sectionIdForStatus(status: TodoStatus): TodoSectionId {
  switch (status) {
    case 'in_progress':
      return 'in-progress';
    case 'completed':
      return 'done';
    case 'open':
    case 'blocked':
    default:
      return 'open-blocked';
  }
}

// Groups items into the three sections in TODO_SECTIONS order. Every section is
// returned even when empty (the accordion never hides a section). Items keep
// their relative input order within each section (stable, single pass).
export function groupTodosBySections<T extends { status: TodoStatus }>(
  items: T[],
): { config: TodoSectionConfig; items: T[] }[] {
  const buckets: Record<TodoSectionId, T[]> = {
    'open-blocked': [],
    'in-progress': [],
    done: [],
  };
  for (const item of items) {
    buckets[sectionIdForStatus(item.status)].push(item);
  }
  return TODO_SECTIONS.map((config) => ({ config, items: buckets[config.id] }));
}
