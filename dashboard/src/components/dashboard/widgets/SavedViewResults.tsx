import { Link } from 'react-router-dom';
import { useMemo } from 'react';
import {
  useAssignmentsBoard,
  type AssignmentBoardItem,
} from '../../../hooks/useProjects';
import { filterAssignment, assignmentDetailHref, type AssignmentFilterCriteria } from '../../../lib/assignmentFilter';
import { useStatusConfig, getStatusLabel } from '../../../hooks/useStatusConfig';
import { sortAssignments } from '../../../lib/sortAssignments';
import { LoadingState } from '../../LoadingState';
import { EmptyState } from '../../EmptyState';
import { KanbanBoard, type KanbanColumn } from '../../KanbanBoard';
import { StatusBadge, getStatusDescription } from '../../StatusBadge';
import { TypeChip } from '../../TypeChip';
import { CopyButton } from '../../CopyButton';
import { formatDate } from '../../../lib/format';
import { SavedViewListView } from './SavedViewListView';
import { SavedViewTableView } from './SavedViewTableView';
import { cn } from '../../../lib/utils';
import type { SavedView } from '@shared/saved-views-schema';

function applyViewFilters(
  items: AssignmentBoardItem[],
  filters: AssignmentFilterCriteria & { search?: string },
  workspace: string | null,
): AssignmentBoardItem[] {
  // `search` is a saved-view filter but `filterAssignment` reads it from `options`,
  // not `criteria` — plumb it explicitly so the results match the board exactly.
  return items.filter((item) => filterAssignment(item, filters, { workspace, search: filters.search }));
}

interface SavedViewResultsProps {
  view: SavedView;
  /** Compact embedding (Overview widget) vs full-page. */
  compact?: boolean;
  /** Empty-state copy (host-specific) — e.g. the widget's "pick another widget" line. */
  emptyDescription?: string;
}

/**
 * The shared filter → sort → render-by-mode body for a saved view. Used both by
 * the Overview `SavedViewWidget` (compact) and the full-page `SavedViewPage`.
 * Owns only the BOARD data lifecycle (loading/error) + empty + render; the VIEW
 * lifecycle (loading/error/not-found) stays in the host so each can show the right chrome.
 */
export function SavedViewResults({ view, compact, emptyDescription }: SavedViewResultsProps) {
  const { data, loading: boardLoading, error: boardError } = useAssignmentsBoard();
  const statusConfig = useStatusConfig();

  const kanbanColumns: KanbanColumn[] = useMemo(
    () =>
      statusConfig.order.map((status) => ({
        id: status,
        title: getStatusLabel(statusConfig, status),
        description: getStatusDescription(status),
      })),
    [statusConfig],
  );

  const sortedItems = useMemo(() => {
    if (!data) return [];
    const filtered = applyViewFilters(data.assignments, view.config.filters, view.workspace);
    return sortAssignments(filtered, view.config.sortField, view.config.sortDirection);
  }, [data, view]);

  if (boardLoading && !data) {
    return <LoadingState label="Loading assignments…" />;
  }

  if (boardError) {
    return (
      <div className="rounded-lg border border-border/60 bg-card/85 px-4 py-3 text-sm">
        <p className="font-medium text-foreground">Couldn't load assignments</p>
        <p className="mt-1 text-xs text-muted-foreground">{boardError}</p>
      </div>
    );
  }

  if (sortedItems.length === 0) {
    return (
      <EmptyState
        title="No assignments match this view."
        description={emptyDescription ?? "Adjust the view's filters to surface different work."}
      />
    );
  }

  switch (view.config.viewMode) {
    case 'kanban':
      return (
        <KanbanBoard
          compact={compact}
          dragDisabled
          columns={kanbanColumns}
          items={sortedItems}
          getItemId={(i) => i.slug || i.id}
          getColumnId={(i) => i.status}
          hiddenColumnIds={view.config.kanbanColumnVisibility.hidden}
          renderCard={(item) =>
            compact ? <CompactAssignmentCard item={item} /> : <ReadOnlyAssignmentCard item={item} />
          }
        />
      );
    case 'list':
      return (
        <SavedViewListView
          items={sortedItems}
          statusOrder={statusConfig.order}
          sortField={view.config.sortField}
          sortDirection={view.config.sortDirection}
          listSectionVisibility={view.config.listSectionVisibility}
          compact={compact}
        />
      );
    case 'table':
      return (
        <SavedViewTableView
          items={sortedItems}
          sortField={view.config.sortField}
          sortDirection={view.config.sortDirection}
          tableColumnVisibility={view.config.tableColumnVisibility}
          compact={compact}
        />
      );
  }
}

/**
 * Read-only compact card for the kanban widget embedding. Mirrors the structure
 * of the full AssignmentBoardCard but without inline edit / drag affordances.
 */
function CompactAssignmentCard({ item }: { item: AssignmentBoardItem }) {
  // Per-item workspace prefix — never use host page's workspace.
  const detailHref = assignmentDetailHref(item);
  return (
    <div className={cn('rounded-md border border-border/60 bg-background/85 p-2 shadow-sm')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <Link
            to={detailHref}
            className="block truncate text-sm font-semibold text-foreground hover:text-primary"
          >
            {item.title}
          </Link>
          <p className="truncate text-xs text-muted-foreground">{item.projectTitle ?? 'Standalone'}</p>
        </div>
        <StatusBadge status={item.status} />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
        <span className="truncate">{item.assignee ?? 'Unassigned'}</span>
        <span className="shrink-0">{formatDate(item.updated)}</span>
      </div>
      {item.id ? (
        <p className="mt-1 inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground/70">
          {item.id.slice(0, 8)}
          <CopyButton value={item.id} />
        </p>
      ) : null}
    </div>
  );
}

/**
 * Larger read-only card for the full-page kanban (the view-detail surface). Same
 * read-only intent as the compact card, but roomier so the page feels first-class.
 */
function ReadOnlyAssignmentCard({ item }: { item: AssignmentBoardItem }) {
  const detailHref = assignmentDetailHref(item);
  return (
    <div className="rounded-lg border border-border/60 bg-background/85 p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <Link
            to={detailHref}
            className="block truncate text-sm font-semibold text-foreground hover:text-primary"
          >
            {item.title}
          </Link>
          <p className="truncate text-xs text-muted-foreground">{item.projectTitle ?? 'Standalone'}</p>
        </div>
        <StatusBadge status={item.status} />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <TypeChip type={item.type} compact />
        <span className="text-xs capitalize text-muted-foreground">{item.priority}</span>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="truncate">{item.assignee ?? 'Unassigned'}</span>
        <span className="shrink-0">{formatDate(item.updated)}</span>
      </div>
    </div>
  );
}
