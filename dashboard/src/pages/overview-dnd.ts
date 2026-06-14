import type { KeyboardCoordinateGetter } from '@dnd-kit/core';

// slotKeyboardCoordinates — LINEAR keyboard reorder (intentional design choice)
//
// ArrowRight / ArrowDown → next slot in array order (+1 index)
// ArrowLeft  / ArrowUp   → previous slot in array order (−1 index)
//
// This is NOT 2D grid navigation. The dashboard models slots as an ordered array
// (reorder semantics, not coordinate placement), so linear ±1 index movement is
// the correct mental model regardless of column count or total slot count.
// AC6 only requires keyboard reordering to keep working, which this satisfies.
//
// True 2D navigation (nearest droppable rect in the arrow direction, row/column-aware)
// would diverge from the pointer reorder model and is intentionally left as a future
// enhancement if coordinate-placement semantics are ever added.
export const slotKeyboardCoordinates: KeyboardCoordinateGetter = (
  event,
  { currentCoordinates, context },
) => {
  const delta =
    event.code === 'ArrowRight' || event.code === 'ArrowDown'
      ? 1
      : event.code === 'ArrowLeft' || event.code === 'ArrowUp'
        ? -1
        : 0;
  if (delta === 0) return;

  event.preventDefault();
  const current = context.over ?? context.active;
  const sortable = current?.data.current?.sortable as
    | { items?: Array<string | number> }
    | undefined;
  const items = sortable?.items;
  if (!current || !items) return currentCoordinates;

  const currentIndex = items.indexOf(current.id);
  if (currentIndex === -1) return currentCoordinates;

  const targetId = items[currentIndex + delta];
  const targetRect = targetId === undefined ? null : context.droppableRects.get(targetId);
  const activeRect = context.collisionRect;
  if (!targetRect || !activeRect) return currentCoordinates;

  return {
    x: targetRect.left + (targetRect.width - activeRect.width) / 2,
    y: targetRect.top + (targetRect.height - activeRect.height) / 2,
  };
};
