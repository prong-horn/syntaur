import { Link } from 'react-router-dom';
import { useMemo } from 'react';
import {
  useAssignmentsBoard,
  type AssignmentBoardItem,
} from '../../../hooks/useProjects';
import { filterAssignment, assignmentDetailHref, type AssignmentFilterCriteria } from '../../../lib/assignmentFilter';
import { useSavedView } from '../../../hooks/useSavedViews';
import { useStatusConfig, getStatusLabel } from '../../../hooks/useStatusConfig';
import { sortAssignments } from '../../../lib/sortAssignments';
import { LoadingState } from '../../LoadingState';
import { EmptyState } from '../../EmptyState';
import { KanbanBoard, type KanbanColumn } from '../../KanbanBoard';
import { StatusBadge, getStatusDescription } from '../../StatusBadge';
import { CopyButton } from '../../CopyButton';
import { formatDate } from '../../../lib/format';
import { SavedViewListView } from './SavedViewListView';
import { SavedViewTableView } from './SavedViewTableView';
import { cn } from '../../../lib/utils';

interface SavedViewWidgetProps {
  viewId: string;
  onPickAnother: () => void;
}

function applyViewFilters(
  items: AssignmentBoardItem[],
  filters: AssignmentFilterCriteria & { search?: string },
  workspace: string | null,
): AssignmentBoardItem[] {
  // `search` is a saved-view filter but `filterAssignment` reads it from `options`,
  // not `criteria` — plumb it explicitly so the widget matches the board exactly.
  return items.filter((item) =>
    filterAssignment(item, filters, { workspace, search: filters.search }),
  );
}

export function SavedViewWidget({ viewId, onPickAnother }: SavedViewWidgetProps) {
  const { view, loading: viewLoading, error: viewError, refetch } = useSavedView(viewId);
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
    if (!view || !data) return [];
    const filtered = applyViewFilters(data.assignments, view.config.filters, view.workspace);
    return sortAssignments(filtered, view.config.sortField, view.config.sortDirection);
  }, [data, view]);

  if (viewLoading || (boardLoading && !data)) {
    return <LoadingState label="Loading view…" />;
  }

  if (viewError) {
    return (
      <div className="rounded-lg border border-border/60 bg-card/85 px-4 py-3 text-sm">
        <p className="font-medium text-foreground">Couldn't load view</p>
        <p className="mt-1 text-xs text-muted-foreground">{viewError.message}</p>
        <button type="button" onClick={() => refetch()} className="shell-action mt-3">
          Retry
        </button>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="rounded-lg border border-border/60 bg-card/85 px-4 py-3 text-sm">
        <p className="font-medium text-foreground">View no longer exists</p>
        <p className="mt-1 text-xs text-muted-foreground">
          The saved view this slot was bound to has been deleted.
        </p>
        <button type="button" onClick={onPickAnother} className="shell-action mt-3">
          Pick another widget
        </button>
      </div>
    );
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
        description="Adjust the view's filters to surface different work, or pick another widget for this slot."
      />
    );
  }

  switch (view.config.viewMode) {
    case 'kanban':
      return (
        <KanbanBoard
          compact
          columns={kanbanColumns}
          items={sortedItems}
          getItemId={(i) => i.slug || i.id}
          getColumnId={(i) => i.status}
          hiddenColumnIds={view.config.kanbanColumnVisibility.hidden}
          renderCard={(item) => <CompactAssignmentCard item={item} />}
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
          compact
        />
      );
    case 'table':
      return (
        <SavedViewTableView
          items={sortedItems}
          sortField={view.config.sortField}
          sortDirection={view.config.sortDirection}
          tableColumnVisibility={view.config.tableColumnVisibility}
          compact
        />
      );
  }
}

/**
 * Read-only compact card for the kanban embedding. Mirrors the structure of the
 * full AssignmentBoardCard but without inline edit / drag affordances — widgets
 * are previews, not the primary edit surface.
 */
function CompactAssignmentCard({ item }: { item: AssignmentBoardItem }) {
  // Per-item workspace prefix — never use host page's workspace. A workspace-scoped
  // widget rendered on the global Overview must still produce /w/<workspace>/... links.
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
          <p className="truncate text-xs text-muted-foreground">
            {item.projectTitle ?? 'Standalone'}
          </p>
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
