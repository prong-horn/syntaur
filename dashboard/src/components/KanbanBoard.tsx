import { Fragment, type DragEvent, type MouseEvent as ReactMouseEvent, type ReactNode, useMemo, useRef, useState } from 'react';
import { cn } from '../lib/utils';

export interface KanbanColumn {
  id: string;
  title: string;
  description?: string;
}

interface DropValidation {
  allowed: boolean;
  reason?: string;
}

interface MovePayload<T> {
  item: T;
  fromColumnId: string;
  toColumnId: string;
  fromIndex: number;
  toIndex: number;
}

/**
 * Closed union of types that external drop targets (e.g., sidebar workspace rows)
 * understand. Producers (kanban consumers) set this via `getExternalDragData`.
 */
export type ExternalDragType = 'project' | 'project-assignment' | 'standalone-assignment';

export interface ExternalDragData {
  type: ExternalDragType;
  id: string;
}

interface KanbanBoardProps<T> {
  columns: KanbanColumn[];
  items: T[];
  getItemId: (item: T) => string;
  getColumnId: (item: T) => string;
  renderCard: (item: T, state: { dragging: boolean }) => ReactNode;
  canDrop?: (payload: { item: T; fromColumnId: string; toColumnId: string }) => DropValidation;
  onMove?: (payload: MovePayload<T>) => void | Promise<void>;
  /**
   * Optional. When set, drag-start additionally emits an `application/json` payload so
   * external drop targets (sidebar rows etc.) can branch on the item type. Independent
   * of `onMove` — a board can support external drag without in-board reordering.
   */
  getExternalDragData?: (item: T) => ExternalDragData | null;
  /**
   * Optional. Fires on right-click of a card whose target is not a nested `<a>` /
   * `<button>` / `[role="button"]` (those keep the native menu). The handler is
   * expected to `preventDefault()` itself if it wants to open a custom popover.
   */
  onCardContextMenu?: (item: T, event: ReactMouseEvent<HTMLElement>) => void;
  emptyMessage?: string | ((column: KanbanColumn) => string);
  /**
   * Optional. Column ids to skip rendering (saved-view column-hide primitive).
   * The remaining `Show hidden columns ▾` chip lists each hidden column with click-to-restore.
   */
  hiddenColumnIds?: string[];
  /**
   * Optional. Called when the user hides a column via its overflow control. The parent
   * is expected to add the id to its own `kanbanColumnVisibility` state and pass the
   * updated `hiddenColumnIds` back in. Kanban itself stores no hidden state internally.
   */
  onHideColumn?: (columnId: string) => void;
  /**
   * Optional. Reduces column min-width and card padding for embedding inside a 5-slot
   * dashboard widget. Default false.
   */
  compact?: boolean;
  /**
   * When true, suppress all drag affordances and short-circuit drop handlers. Use
   * for read-only grouping modes (e.g. group-by-type) where re-bucketing by drag
   * isn't supported. Default false — preserves existing call-site behavior.
   */
  dragDisabled?: boolean;
}

interface DropTarget {
  columnId: string;
  index: number;
}

// Elements that should never initiate a drag and should never trigger the
// card's right-click context menu. Includes form controls, content-editable
// regions, role="button" elements, and anything explicitly opting out via
// `data-no-drag`. Inline-edit affordances (status pill picker, title editor)
// rely on this list, so widening it should not break drag for the card body.
const NON_DRAGGABLE_SELECTOR =
  'a, button, input, select, textarea, [contenteditable="true"], [role="button"], [data-no-drag]';

export function KanbanBoard<T>({
  columns,
  items,
  getItemId,
  getColumnId,
  renderCard,
  canDrop,
  onMove,
  getExternalDragData,
  onCardContextMenu,
  emptyMessage = 'No cards in this column.',
  hiddenColumnIds,
  onHideColumn,
  compact = false,
  dragDisabled = false,
}: KanbanBoardProps<T>) {
  const hiddenSet = useMemo(() => new Set(hiddenColumnIds ?? []), [hiddenColumnIds]);
  const visibleColumns = useMemo(
    () => columns.filter((c) => !hiddenSet.has(c.id)),
    [columns, hiddenSet],
  );
  const hiddenColumns = useMemo(
    () => columns.filter((c) => hiddenSet.has(c.id)),
    [columns, hiddenSet],
  );
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const mouseDownTarget = useRef<EventTarget | null>(null);

  const itemsById = useMemo(
    () => new Map(items.map((item) => [getItemId(item), item])),
    [getItemId, items],
  );
  const groupedColumns = useMemo(
    () =>
      visibleColumns.map((column) => ({
        column,
        items: items.filter((item) => getColumnId(item) === column.id),
      })),
    [visibleColumns, getColumnId, items],
  );

  const draggedItem = draggedId ? itemsById.get(draggedId) ?? null : null;

  function getDropValidation(targetColumnId: string): DropValidation {
    if (!draggedItem) {
      return { allowed: false };
    }

    const fromColumnId = getColumnId(draggedItem);
    return canDrop?.({ item: draggedItem, fromColumnId, toColumnId: targetColumnId }) ?? { allowed: true };
  }

  function clearDragState() {
    setDraggedId(null);
    setDropTarget(null);
  }

  function handleDragStart(event: DragEvent<HTMLDivElement>, item: T, itemId: string) {
    if (dragDisabled) return;
    const external = getExternalDragData?.(item) ?? null;

    if (!onMove && !external) {
      return;
    }

    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', itemId);

    if (external) {
      event.dataTransfer.setData('application/json', JSON.stringify(external));
    }

    if (onMove) {
      setDraggedId(itemId);
    }
  }

  function handleDragOver(event: DragEvent<HTMLElement>, columnId: string, index: number) {
    if (dragDisabled || !onMove || !draggedItem) {
      return;
    }

    const validation = getDropValidation(columnId);
    if (!validation.allowed) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTarget((current) =>
      current?.columnId === columnId && current.index === index ? current : { columnId, index },
    );
  }

  async function handleDrop(event: DragEvent<HTMLElement>, columnId: string, index: number) {
    event.preventDefault();

    if (dragDisabled || !onMove || !draggedItem) {
      clearDragState();
      return;
    }

    const fromColumnId = getColumnId(draggedItem);
    const fromItems = groupedColumns.find((group) => group.column.id === fromColumnId)?.items ?? [];
    const fromIndex = fromItems.findIndex((item) => getItemId(item) === getItemId(draggedItem));
    const validation = getDropValidation(columnId);

    if (!validation.allowed || fromIndex < 0) {
      clearDragState();
      return;
    }

    if (fromColumnId === columnId && (index === fromIndex || index === fromIndex + 1)) {
      clearDragState();
      return;
    }

    try {
      await onMove({
        item: draggedItem,
        fromColumnId,
        toColumnId: columnId,
        fromIndex,
        toIndex: index,
      });
    } finally {
      clearDragState();
    }
  }

  return (
    <div
      className="relative overflow-x-auto pb-2"
      style={{
        scrollbarColor: 'oklch(var(--border)) transparent',
        scrollbarWidth: 'thin',
      }}
    >
      {hiddenColumns.length > 0 && onHideColumn ? (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>Hidden:</span>
          {hiddenColumns.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onHideColumn(c.id)}
              className="rounded-full border border-dashed border-border/60 px-2 py-0.5 hover:border-border hover:text-foreground"
              title={`Restore "${c.title}" column`}
            >
              {c.title} ×
            </button>
          ))}
        </div>
      ) : null}
      <div
        className={cn(
          'grid min-w-max grid-flow-col gap-4',
          compact ? 'auto-cols-[minmax(200px,240px)]' : 'auto-cols-[minmax(260px,320px)]',
        )}
      >
        {groupedColumns.map(({ column, items: columnItems }) => {
          const validation = getDropValidation(column.id);
          const isDropColumn = dropTarget?.columnId === column.id;

          return (
            <section
              key={column.id}
              className={cn(
                'flex flex-col rounded-lg border border-border/60 bg-card/85 shadow-sm',
                compact ? 'min-h-[200px] p-2' : 'min-h-[320px] p-3',
                draggedItem && !validation.allowed ? 'border-dashed opacity-65' : '',
                draggedItem && validation.allowed ? 'border-primary/30 bg-accent/30' : '',
                isDropColumn ? 'ring-2 ring-ring/30' : '',
              )}
              title={draggedItem && !validation.allowed ? validation.reason : undefined}
            >
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <h2 className={cn(
                    'font-semibold uppercase tracking-[0.16em] text-muted-foreground',
                    compact ? 'text-xs' : 'text-sm',
                  )}>
                    {column.title}
                  </h2>
                  {column.description && !compact ? (
                    <p className="text-sm leading-6 text-muted-foreground">{column.description}</p>
                  ) : null}
                </div>
                <div className="flex items-center gap-1">
                  <span className="rounded-full border border-border/60 bg-background/80 px-2.5 py-1 text-xs font-semibold text-foreground">
                    {columnItems.length}
                  </span>
                  {onHideColumn ? (
                    <button
                      type="button"
                      onClick={() => onHideColumn(column.id)}
                      className="rounded-full border border-transparent px-1.5 py-0.5 text-xs text-muted-foreground hover:border-border hover:text-foreground"
                      title={`Hide "${column.title}" column`}
                      aria-label={`Hide column ${column.title}`}
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              </div>

              <div
                className="flex flex-1 flex-col gap-3"
                onDragOver={(event) => handleDragOver(event, column.id, columnItems.length)}
                onDrop={(event) => handleDrop(event, column.id, columnItems.length)}
              >
                {columnItems.length === 0 ? (
                  dragDisabled ? (
                    <div className="flex min-h-[128px] items-center justify-center rounded-lg border border-border/60 bg-background/50 px-4 text-center text-sm text-muted-foreground">
                      {typeof emptyMessage === 'function' ? emptyMessage(column) : emptyMessage}
                    </div>
                  ) : (
                    <DropZone
                      active={dropTarget?.columnId === column.id && dropTarget.index === 0}
                      disabled={Boolean(draggedItem) && !validation.allowed}
                    >
                      {typeof emptyMessage === 'function' ? emptyMessage(column) : emptyMessage}
                    </DropZone>
                  )
                ) : null}

                {columnItems.map((item, index) => {
                  const itemId = getItemId(item);
                  const isDragging = draggedId === itemId;

                  return (
                    <Fragment key={itemId}>
                      <div
                        className={cn(
                          'h-2 rounded-full transition',
                          dropTarget?.columnId === column.id && dropTarget.index === index
                            ? 'bg-primary/70'
                            : 'bg-transparent',
                        )}
                        onDragOver={(event) => handleDragOver(event, column.id, index)}
                        onDrop={(event) => handleDrop(event, column.id, index)}
                      />
                      <div
                        draggable={!dragDisabled && Boolean(onMove || getExternalDragData)}
                        onMouseDown={(e) => {
                          mouseDownTarget.current = e.target;
                        }}
                        onDragStart={(event) => {
                          const target = mouseDownTarget.current as HTMLElement | null;
                          if (target?.closest(NON_DRAGGABLE_SELECTOR)) {
                            event.preventDefault();
                            return;
                          }
                          handleDragStart(event, item, itemId);
                        }}
                        onDragEnd={clearDragState}
                        onContextMenu={(event) => {
                          if (!onCardContextMenu) return;
                          const target = event.target as HTMLElement | null;
                          // Right-clicks on nested interactive elements keep the native menu
                          // (e.g., "Open link in new tab" on the card title link, or text-input
                          // context actions on the inline title editor).
                          if (target?.closest(NON_DRAGGABLE_SELECTOR)) return;
                          onCardContextMenu(item, event);
                        }}
                        className={cn(
                          'transition',
                          !dragDisabled && (onMove || getExternalDragData) ? 'cursor-grab active:cursor-grabbing' : '',
                          isDragging ? 'scale-[0.98] opacity-50' : '',
                        )}
                      >
                        {renderCard(item, { dragging: isDragging })}
                      </div>
                    </Fragment>
                  );
                })}

                {columnItems.length > 0 && !dragDisabled ? (
                  <div
                    className={cn(
                      'mt-1 rounded-md border border-dashed px-3 py-2 text-center text-xs text-muted-foreground transition',
                      dropTarget?.columnId === column.id && dropTarget.index === columnItems.length
                        ? 'border-primary/50 bg-primary/10 text-foreground'
                        : 'border-border/60',
                      draggedItem && !validation.allowed ? 'opacity-40' : '',
                    )}
                  >
                    Drop here to place at the end
                  </div>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function DropZone({
  active,
  disabled,
  children,
}: {
  active: boolean;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex min-h-[128px] items-center justify-center rounded-lg border border-dashed px-4 text-center text-sm text-muted-foreground transition',
        active ? 'border-primary/60 bg-primary/10 text-foreground' : 'border-border/60 bg-background/50',
        disabled ? 'opacity-45' : '',
      )}
    >
      {children}
    </div>
  );
}
