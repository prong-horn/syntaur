import { Fragment, type DragEvent, type ReactNode, useMemo, useState } from 'react';
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

interface KanbanBoardProps<T> {
  columns: KanbanColumn[];
  items: T[];
  getItemId: (item: T) => string;
  getColumnId: (item: T) => string;
  renderCard: (item: T, state: { dragging: boolean }) => ReactNode;
  canDrop?: (payload: { item: T; fromColumnId: string; toColumnId: string }) => DropValidation;
  onMove?: (payload: MovePayload<T>) => void | Promise<void>;
  emptyMessage?: string | ((column: KanbanColumn) => string);
}

interface DropTarget {
  columnId: string;
  index: number;
}

export function KanbanBoard<T>({
  columns,
  items,
  getItemId,
  getColumnId,
  renderCard,
  canDrop,
  onMove,
  emptyMessage = 'No cards in this column.',
}: KanbanBoardProps<T>) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  const itemsById = useMemo(
    () => new Map(items.map((item) => [getItemId(item), item])),
    [getItemId, items],
  );
  const groupedColumns = useMemo(
    () =>
      columns.map((column) => ({
        column,
        items: items.filter((item) => getColumnId(item) === column.id),
      })),
    [columns, getColumnId, items],
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

  function handleDragStart(event: DragEvent<HTMLDivElement>, itemId: string) {
    if (!onMove) {
      return;
    }

    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', itemId);
    setDraggedId(itemId);
  }

  function handleDragOver(event: DragEvent<HTMLElement>, columnId: string, index: number) {
    if (!onMove || !draggedItem) {
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

    if (!onMove || !draggedItem) {
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
    <div className="overflow-x-auto pb-2">
      <div className="grid min-w-max auto-cols-[minmax(260px,320px)] grid-flow-col gap-4">
        {groupedColumns.map(({ column, items: columnItems }) => {
          const validation = getDropValidation(column.id);
          const isDropColumn = dropTarget?.columnId === column.id;

          return (
            <section
              key={column.id}
              className={cn(
                'flex min-h-[320px] flex-col rounded-lg border border-border/60 bg-card/85 p-3 shadow-sm',
                draggedItem && !validation.allowed ? 'border-dashed opacity-65' : '',
                draggedItem && validation.allowed ? 'border-primary/30 bg-accent/30' : '',
                isDropColumn ? 'ring-2 ring-ring/30' : '',
              )}
              title={draggedItem && !validation.allowed ? validation.reason : undefined}
            >
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    {column.title}
                  </h2>
                  {column.description ? (
                    <p className="text-sm leading-6 text-muted-foreground">{column.description}</p>
                  ) : null}
                </div>
                <span className="rounded-full border border-border/60 bg-background/80 px-2.5 py-1 text-xs font-semibold text-foreground">
                  {columnItems.length}
                </span>
              </div>

              <div
                className="flex flex-1 flex-col gap-3"
                onDragOver={(event) => handleDragOver(event, column.id, columnItems.length)}
                onDrop={(event) => handleDrop(event, column.id, columnItems.length)}
              >
                {columnItems.length === 0 ? (
                  <DropZone
                    active={dropTarget?.columnId === column.id && dropTarget.index === 0}
                    disabled={Boolean(draggedItem) && !validation.allowed}
                  >
                    {typeof emptyMessage === 'function' ? emptyMessage(column) : emptyMessage}
                  </DropZone>
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
                        draggable={Boolean(onMove)}
                        onDragStart={(event) => handleDragStart(event, itemId)}
                        onDragEnd={clearDragState}
                        className={cn(
                          'transition',
                          onMove ? 'cursor-grab active:cursor-grabbing' : '',
                          isDragging ? 'scale-[0.98] opacity-50' : '',
                        )}
                      >
                        {renderCard(item, { dragging: isDragging })}
                      </div>
                    </Fragment>
                  );
                })}

                {columnItems.length > 0 ? (
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
