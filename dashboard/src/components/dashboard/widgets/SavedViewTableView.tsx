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
// Shared sorter — single source of truth (parsed-epoch date sort, etc.).
import { sortAssignments } from '../../../lib/sortAssignments';

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
            {showCol('created') ? (
              <th className={cn('font-medium', cellPadding)}>Created</th>
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
                    <StatusBadge status={assignment.status} className="max-w-[150px]" />
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
                {showCol('created') ? (
                  <td className={cn('text-muted-foreground', cellPadding)}>
                    {formatDate(assignment.created)}
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
