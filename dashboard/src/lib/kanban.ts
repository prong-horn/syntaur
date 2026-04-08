export const DEFAULT_MISSION_BOARD_COLUMNS = [
  'pending',
  'active',
  'blocked',
  'failed',
  'completed',
  'archived',
] as const;

export const MISSION_BOARD_COLUMNS = DEFAULT_MISSION_BOARD_COLUMNS;

export const DEFAULT_ASSIGNMENT_BOARD_COLUMNS = [
  'pending',
  'in_progress',
  'blocked',
  'review',
  'completed',
  'failed',
] as const;

export const ASSIGNMENT_BOARD_COLUMNS = DEFAULT_ASSIGNMENT_BOARD_COLUMNS;

export function getAssignmentColumns(configOrder?: string[]): string[] {
  return configOrder && configOrder.length > 0
    ? configOrder
    : [...DEFAULT_ASSIGNMENT_BOARD_COLUMNS];
}

export function moveItem<T>(
  items: T[],
  fromIndex: number,
  toIndex: number,
): T[] {
  if (fromIndex < 0 || fromIndex >= items.length) {
    return items;
  }

  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  const targetIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
  next.splice(Math.max(0, Math.min(targetIndex, next.length)), 0, item);
  return next;
}
