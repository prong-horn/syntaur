import type { KeyboardCoordinateGetter } from '@dnd-kit/core';

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
