import { DEFAULT_ASSIGNMENT_BOARD_COLUMNS } from './kanban';

/** Minimal shape a board item must expose for workflow-aware grouping. Satisfied
 * by AssignmentSummary / AssignmentBoardItem (Task 9 payload fields). */
export interface WorkflowBoardItem {
  resolvedWorkflow: string;
  workflowLabel: string;
  status: string;
}

export interface WorkflowLane<T> {
  workflowId: string;
  label: string;
  /** Column ids for this lane, in render order. */
  columns: string[];
  items: T[];
}

/**
 * Column order for a single swimlane. When the workflow's canonical status order
 * is known, use it verbatim (mode A per-workflow columns). Otherwise derive from
 * the statuses actually present, arranged by the default board order with unknown
 * statuses appended alphabetically. Pure + deterministic (no fetch needed).
 */
export function laneColumns(
  items: { status: string }[],
  workflowOrder?: string[],
): string[] {
  if (workflowOrder && workflowOrder.length > 0) return [...workflowOrder];
  const present = new Set(items.map((i) => i.status));
  const ordered: string[] = [];
  for (const s of DEFAULT_ASSIGNMENT_BOARD_COLUMNS) {
    if (present.has(s)) {
      ordered.push(s);
      present.delete(s);
    }
  }
  for (const s of [...present].sort()) ordered.push(s);
  return ordered;
}

/**
 * Group board items into per-workflow swimlanes (board render mode B). Lanes are
 * ordered by first appearance (stable); items keep their input order within a
 * lane. `orderByWorkflow` optionally supplies each workflow's canonical status
 * order so lanes render mode-A columns instead of derived ones.
 */
export function buildWorkflowLanes<T extends WorkflowBoardItem>(
  items: T[],
  orderByWorkflow: Record<string, string[]> = {},
): WorkflowLane<T>[] {
  const laneMap = new Map<string, { label: string; items: T[] }>();
  for (const item of items) {
    const wf = item.resolvedWorkflow;
    let lane = laneMap.get(wf);
    if (!lane) {
      lane = { label: item.workflowLabel || wf, items: [] };
      laneMap.set(wf, lane);
    }
    lane.items.push(item);
  }
  const lanes: WorkflowLane<T>[] = [];
  for (const [workflowId, lane] of laneMap) {
    lanes.push({
      workflowId,
      label: lane.label,
      columns: laneColumns(lane.items, orderByWorkflow[workflowId]),
      items: lane.items,
    });
  }
  return lanes;
}

/**
 * Whether a set of items spans more than one resolved workflow — i.e. whether a
 * swimlane / normalized view adds value over a single per-workflow board.
 */
export function isMixedWorkflow(items: WorkflowBoardItem[]): boolean {
  if (items.length === 0) return false;
  const first = items[0].resolvedWorkflow;
  return items.some((i) => i.resolvedWorkflow !== first);
}
