import { Link } from 'react-router-dom';
import { cn } from '../../../lib/utils';
import { formatDate } from '../../../lib/format';
import { StatusBadge } from '../../StatusBadge';
import type { AssignmentBoardItem } from '../../../hooks/useProjects';
import type { SortField, SortDirection } from '@shared/view-prefs-schema';
import type {
  TableColumnId,
  TableColumnVisibility,
} from '@shared/saved-views-schema';

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function sortAssignments(
  items: AssignmentBoardItem[],
  field: SortField,
  direction: SortDirection,
): AssignmentBoardItem[] {
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

// Standalone items NEVER get a /w/<ws> prefix — no such route exists.
function buildAssignmentHref(item: AssignmentBoardItem): string {
  if (item.projectSlug === null) {
    return `/assignments/${item.id}`;
  }
  const prefix = item.projectWorkspace ? `/w/${item.projectWorkspace}` : '';
  return `${prefix}/projects/${item.projectSlug}/assignments/${item.slug}`;
}

interface SavedViewTableViewProps {
  items: AssignmentBoardItem[];
  sortField: SortField;
  sortDirection: SortDirection;
  tableColumnVisibility: TableColumnVisibility;
  compact?: boolean;
}

export function SavedViewTableView({
  items,
  sortField,
  sortDirection,
  tableColumnVisibility,
  compact = false,
}: SavedViewTableViewProps) {
  const hidden = new Set<TableColumnId>(tableColumnVisibility.hidden);
  // Title is always shown (non-hideable per Decision 9).
  hidden.delete('title');
  const showCol = (id: TableColumnId) => !hidden.has(id);

  const sorted = sortAssignments(items, sortField, sortDirection);

  const cellPadding = compact ? 'py-2 pr-3' : 'py-3 pr-4';
  const tableTextSize = compact ? 'text-xs' : 'text-sm';

  return (
    <div className="overflow-x-auto">
      <table className={cn('w-full text-left', tableTextSize)}>
        <thead>
          <tr className="border-b border-border/60 text-muted-foreground">
            {showCol('title') ? (
              <th className={cn('font-medium', cellPadding)}>Assignment</th>
            ) : null}
            {showCol('status') ? (
              <th className={cn('font-medium', cellPadding)}>Status</th>
            ) : null}
            {showCol('priority') ? (
              <th className={cn('font-medium', cellPadding)}>Priority</th>
            ) : null}
            {showCol('assignee') ? (
              <th className={cn('font-medium', cellPadding)}>Assignee</th>
            ) : null}
            {showCol('dependencies') ? (
              <th className={cn('font-medium', cellPadding)}>Dependencies</th>
            ) : null}
            {showCol('updated') ? (
              <th className={cn('font-medium', cellPadding)}>Updated</th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {sorted.map((assignment) => {
            const href = buildAssignmentHref(assignment);
            const rowKey = `${assignment.projectSlug ?? 'standalone'}:${assignment.id}`;
            return (
              <tr
                key={rowKey}
                className="border-b border-border/50 last:border-0"
              >
                {showCol('title') ? (
                  <td className={cellPadding}>
                    <Link
                      to={href}
                      className="font-semibold text-foreground hover:text-primary"
                    >
                      {assignment.title}
                    </Link>
                    {assignment.projectTitle ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {assignment.projectTitle}
                      </p>
                    ) : null}
                  </td>
                ) : null}
                {showCol('status') ? (
                  <td className={cellPadding}>
                    <StatusBadge status={assignment.status} />
                  </td>
                ) : null}
                {showCol('priority') ? (
                  <td className={cn('capitalize text-muted-foreground', cellPadding)}>
                    {assignment.priority}
                  </td>
                ) : null}
                {showCol('assignee') ? (
                  <td className={cn('text-muted-foreground', cellPadding)}>
                    {assignment.assignee ?? 'Unassigned'}
                  </td>
                ) : null}
                {showCol('dependencies') ? (
                  <td className={cn('text-muted-foreground', cellPadding)}>
                    {assignment.dependsOn.length}
                  </td>
                ) : null}
                {showCol('updated') ? (
                  <td className={cn('text-muted-foreground', cellPadding)}>
                    {formatDate(assignment.updated)}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
