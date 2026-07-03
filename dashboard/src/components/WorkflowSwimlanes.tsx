import { useMemo, type ReactNode } from 'react';
import { KanbanBoard, type KanbanColumn } from './KanbanBoard';
import {
  buildWorkflowLanes,
  type WorkflowBoardItem,
  type WorkflowLane,
} from '../lib/workflow-board';

function humanize(id: string): string {
  return id.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

interface StatusLabeled extends WorkflowBoardItem {
  statusLabel?: string;
}

/**
 * Board render mode B (Task 14): one read-only KanbanBoard per resolved workflow,
 * stacked as swimlanes. Each lane's columns come from that workflow's own status
 * order (or the statuses present), so mixed-workflow boards stay legible instead
 * of collapsing distinct lifecycles into one ambiguous column set. Lanes are
 * pre-grouped + memoized so re-renders don't re-bucket every card.
 */
export function WorkflowSwimlanes<T extends StatusLabeled>({
  items,
  getItemId,
  renderCard,
  orderByWorkflow,
  emptyMessage,
}: {
  items: T[];
  getItemId: (item: T) => string;
  renderCard: (item: T, state: { dragging: boolean }) => ReactNode;
  orderByWorkflow?: Record<string, string[]>;
  emptyMessage?: (column: KanbanColumn) => string;
}) {
  const lanes = useMemo(
    () => buildWorkflowLanes(items, orderByWorkflow ?? {}),
    [items, orderByWorkflow],
  );

  if (lanes.length === 0) return null;

  return (
    <div className="space-y-6">
      {lanes.map((lane) => (
        <WorkflowLaneBoard
          key={lane.workflowId}
          lane={lane}
          getItemId={getItemId}
          renderCard={renderCard}
          emptyMessage={emptyMessage}
        />
      ))}
    </div>
  );
}

function WorkflowLaneBoard<T extends StatusLabeled>({
  lane,
  getItemId,
  renderCard,
  emptyMessage,
}: {
  lane: WorkflowLane<T>;
  getItemId: (item: T) => string;
  renderCard: (item: T, state: { dragging: boolean }) => ReactNode;
  emptyMessage?: (column: KanbanColumn) => string;
}) {
  const columns = useMemo<KanbanColumn[]>(() => {
    // Prefer the per-item statusLabel (real label within this workflow); fall
    // back to a humanized id for order-supplied columns that have no item.
    const labelByStatus = new Map<string, string>();
    for (const it of lane.items) if (it.statusLabel) labelByStatus.set(it.status, it.statusLabel);
    return lane.columns.map((id) => ({ id, title: labelByStatus.get(id) ?? humanize(id) }));
  }, [lane]);

  return (
    <section>
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
        {lane.label}
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-normal text-muted-foreground">
          {lane.items.length}
        </span>
      </h3>
      <KanbanBoard
        columns={columns}
        items={lane.items}
        getItemId={getItemId}
        getColumnId={(i) => i.status}
        renderCard={renderCard}
        dragDisabled
        boundedColumns
        emptyMessage={emptyMessage}
      />
    </section>
  );
}
