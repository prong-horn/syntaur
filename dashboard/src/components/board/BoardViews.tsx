import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { KanbanBoard, type KanbanColumn } from '../KanbanBoard';
import { SectionCard } from '../SectionCard';
import { EmptyState } from '../EmptyState';
import { InlineTitleEditor } from '../InlineTitleEditor';
import { TemplateChip } from '../TemplateChip';
import { TicketMetrics } from '../ticket/TicketMetrics';
import { cn } from '../../lib/utils';
import { formatDate } from '../../lib/format';
import { ticketDetailHref } from '../../lib/ticketFilter';
import { validateStageColumnDrop } from '../../lib/kanbanDrop';
import { useBodyClickNavigation } from '../../hooks/useBodyClickNavigation';
import type { TicketBoardItem } from '../../data/types';
import type { BoardFilterState } from '../../hooks/useBoardFilters';
import type { SortField, TableColumnId } from '@shared/view-prefs-schema';
import { TicketBoardCard } from './TicketBoardCard';
import { getTicketAction } from '../../hooks/useBoardActions';

const UNKNOWN_TYPE_COLUMN_ID = '__unknown_type__';

export interface BoardViewsProps {
  state: BoardFilterState;
  items: TicketBoardItem[];
  sortedItems: TicketBoardItem[];
  kanbanColumns: KanbanColumn[];
  typeKanbanColumns: KanbanColumn[];
  columnLabels: Record<string, string>;
  knownTypeIds: Set<string>;
  listGroups: Array<{ id: string; label: string; items: TicketBoardItem[] }>;
  onMove: (args: { item: TicketBoardItem; toColumnId: string; action?: TicketBoardItem['availableVerbs'][0] }) => void;
  onRenameTitle: (item: TicketBoardItem, title: string) => Promise<void>;
  transitioningId: string | null;
  onSort: (field: SortField) => void;
  onClearFilters: () => void;
  onCardContextMenu?: (item: TicketBoardItem, event: React.MouseEvent) => void;
  tableColumnVisibility: { hidden: TableColumnId[] };
  kanbanColumnVisibility: { hidden: string[] };
  onKanbanColumnVisibilityChange: (next: { hidden: string[] }) => void;
}

function ticketKey(ticket: Pick<TicketBoardItem, 'id' | 'slug'>): string {
  return ticket.id || ticket.slug || 'unknown';
}

function ClickableTableRow({
  detailHref,
  children,
  className,
}: {
  detailHref: string;
  children: React.ReactNode;
  className?: string;
}) {
  const nav = useBodyClickNavigation<HTMLTableRowElement>(detailHref);
  return (
    <tr
      ref={nav.containerRef}
      className={className}
      onMouseDown={nav.onMouseDown}
      onClick={nav.onClick}
    >
      {children}
    </tr>
  );
}

export function BoardViews({
  state,
  items,
  sortedItems,
  kanbanColumns,
  typeKanbanColumns,
  columnLabels,
  knownTypeIds,
  listGroups,
  onMove,
  onRenameTitle,
  transitioningId,
  onSort,
  onClearFilters,
  onCardContextMenu,
  tableColumnVisibility,
  kanbanColumnVisibility,
  onKanbanColumnVisibilityChange,
}: BoardViewsProps) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());

  const effectiveKanbanGrouping = state.grouping === 'type' ? 'type' : 'status';
  const typeColumns = useMemo(() => {
    const hasUnknown = items.some((it) => !it.template || !knownTypeIds.has(it.template));
    return hasUnknown
      ? [...typeKanbanColumns, { id: UNKNOWN_TYPE_COLUMN_ID, title: 'Other', description: 'Unrecognized type' }]
      : typeKanbanColumns;
  }, [items, knownTypeIds, typeKanbanColumns]);

  if (items.length === 0) {
    return (
      <EmptyState
        title="No tickets yet"
        description="Tickets appear once projects contain work items."
        actions={
          <button type="button" className="shell-action shell-action--cta" onClick={() => onClearFilters()}>
            Browse projects
          </button>
        }
      />
    );
  }

  if (sortedItems.length === 0) {
    return (
      <EmptyState
        title="No tickets match these filters"
        description="Adjust filters or history settings."
        actions={
          <button type="button" className="shell-action shell-action--cta" onClick={onClearFilters}>
            Clear filters
          </button>
        }
      />
    );
  }

  function SortHeader({ field, children }: { field: SortField; children: React.ReactNode }) {
    const active = state.sortField === field;
    return (
      <th className="pb-3 font-medium">
        <button type="button" onClick={() => onSort(field)} className="inline-flex items-center gap-1 hover:text-foreground">
          {children}
          {active ? (state.sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />) : null}
        </button>
      </th>
    );
  }

  if (state.view === 'table') {
    const hiddenCols = new Set(tableColumnVisibility.hidden);
    const showCol = (id: TableColumnId) => id === 'title' || !hiddenCols.has(id);
    return (
      <SectionCard title={`${sortedItems.length} ticket${sortedItems.length === 1 ? '' : 's'}`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-border/60 text-muted-foreground">
                {showCol('title') ? <SortHeader field="title">Ticket</SortHeader> : null}
                {showCol('status') ? <SortHeader field="status">Status</SortHeader> : null}
                <th className="pb-3 font-medium">Metrics</th>
                <th className="pb-3 font-medium">Type</th>
                {showCol('priority') ? <SortHeader field="priority">Priority</SortHeader> : null}
                {showCol('assignee') ? <SortHeader field="assignee">Assignee</SortHeader> : null}
                {showCol('updated') ? <SortHeader field="updated">Updated</SortHeader> : null}
              </tr>
            </thead>
            <tbody>
              {sortedItems.map((ticket) => (
                <ClickableTableRow
                  key={ticketKey(ticket)}
                  detailHref={ticketDetailHref(ticket)}
                  className="cursor-pointer border-b border-border/50 transition hover:bg-muted/40 last:border-0"
                >
                  {showCol('title') ? (
                    <td className="py-4 pr-4">
                      <InlineTitleEditor
                        title={ticket.title}
                        detailHref={ticketDetailHref(ticket)}
                        onSave={(next) => onRenameTitle(ticket, next)}
                        disabled={transitioningId === ticketKey(ticket)}
                      />
                    </td>
                  ) : null}
                  {showCol('status') ? (
                    <td className="py-4 pr-4 capitalize text-muted-foreground">{columnLabels[ticket.status] ?? ticket.status}</td>
                  ) : null}
                  <td className="py-4 pr-4"><TicketMetrics metrics={ticket.metrics} variant="card" /></td>
                  <td className="py-4 pr-4"><TemplateChip template={ticket.template} compact /></td>
                  {showCol('priority') ? <td className="py-4 pr-4 capitalize text-muted-foreground">{ticket.priority}</td> : null}
                  {showCol('assignee') ? <td className="py-4 pr-4 text-muted-foreground">{ticket.assignee ?? 'Unassigned'}</td> : null}
                  {showCol('updated') ? <td className="py-4 text-muted-foreground">{formatDate(ticket.updated)}</td> : null}
                </ClickableTableRow>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    );
  }

  if (state.view === 'list') {
    return (
      <div className="space-y-3">
        {listGroups.map(({ id: groupId, label, items: groupItems }) => {
          if (groupItems.length === 0) return null;
          const expanded = !collapsedGroups.has(groupId);
          return (
            <div key={groupId} className="rounded-lg border border-border/60 bg-card/90">
              <button
                type="button"
                onClick={() =>
                  setCollapsedGroups((current) => {
                    const next = new Set(current);
                    if (next.has(groupId)) next.delete(groupId);
                    else next.add(groupId);
                    return next;
                  })
                }
                className="flex w-full items-center gap-2 px-4 py-3 text-left"
              >
                <ChevronDown className={cn('h-4 w-4 transition-transform', !expanded && '-rotate-90')} />
                <span className="font-semibold">{label}</span>
                <span className="rounded-full border border-border/60 px-2 py-0.5 text-xs text-muted-foreground">
                  {groupItems.length}
                </span>
              </button>
              {expanded ? (
                <div className="space-y-3 px-4 pb-4">
                  {groupItems.map((item) => (
                    <TicketBoardCard
                      key={ticketKey(item)}
                      ticket={item}
                      transitioning={transitioningId === ticketKey(item)}
                      onPillSelect={(action) => void onMove({ item, toColumnId: action.targetStatus, action })}
                      onRenameTitle={(next) => onRenameTitle(item, next)}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <KanbanBoard
      columns={effectiveKanbanGrouping === 'type' ? typeColumns : kanbanColumns}
      items={sortedItems}
      getItemId={ticketKey}
      getColumnId={(item) =>
        effectiveKanbanGrouping === 'type'
          ? item.template && knownTypeIds.has(item.template)
            ? item.template
            : UNKNOWN_TYPE_COLUMN_ID
          : item.status
      }
      canDrop={({ item, fromColumnId, toColumnId }) =>
        validateStageColumnDrop({ fromColumnId, toColumnId, action: getTicketAction(item, toColumnId) })
      }
      onMove={effectiveKanbanGrouping === 'type' ? undefined : ({ item, toColumnId }) => onMove({ item, toColumnId })}
      dragDisabled={effectiveKanbanGrouping === 'type'}
      onCardContextMenu={onCardContextMenu}
      hiddenColumnIds={kanbanColumnVisibility.hidden}
      onHideColumn={(columnId) =>
        onKanbanColumnVisibilityChange({
          hidden: kanbanColumnVisibility.hidden.includes(columnId)
            ? kanbanColumnVisibility.hidden.filter((c) => c !== columnId)
            : [...kanbanColumnVisibility.hidden, columnId],
        })
      }
      renderCard={(item, { dragging }) => (
        <TicketBoardCard
          ticket={item}
          dragging={dragging}
          transitioning={transitioningId === ticketKey(item)}
          onPillSelect={(action) => void onMove({ item, toColumnId: action.targetStatus, action })}
          onRenameTitle={(next) => onRenameTitle(item, next)}
        />
      )}
    />
  );
}
