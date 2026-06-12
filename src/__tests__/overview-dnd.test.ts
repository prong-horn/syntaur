import { describe, expect, it, vi } from 'vitest';
import { slotKeyboardCoordinates } from '../../dashboard/src/pages/overview-dnd';

function runCoordinateGetter(options: {
  code: string;
  activeId?: string;
  overId?: string | null;
  items?: string[];
  activeRect?: { left: number; top: number; width: number; height: number } | null;
  rects?: Map<string, { left: number; top: number; width: number; height: number }>;
}) {
  const preventDefault = vi.fn();
  const items = options.items ?? ['slot-0', 'slot-1', 'slot-2'];
  const entry = (id: string) => ({
    id,
    data: { current: { sortable: { items } } },
  });
  const activeId = options.activeId ?? 'slot-0';
  const overId = options.overId === undefined ? activeId : options.overId;

  const result = slotKeyboardCoordinates(
    { code: options.code, preventDefault } as KeyboardEvent,
    {
      active: activeId,
      currentCoordinates: { x: 10, y: 20 },
      context: {
        active: entry(activeId),
        over: overId === null ? null : entry(overId),
        collisionRect: options.activeRect ?? { left: 0, top: 0, width: 100, height: 40 },
        droppableRects:
          options.rects ??
          new Map([
            ['slot-0', { left: 0, top: 0, width: 100, height: 40 }],
            ['slot-1', { left: 200, top: 300, width: 50, height: 80 }],
            ['slot-2', { left: 300, top: 500, width: 60, height: 90 }],
          ]),
      },
    } as Parameters<typeof slotKeyboardCoordinates>[1],
  );

  return { result, preventDefault };
}

describe('slotKeyboardCoordinates', () => {
  it('centers a differently sized active slot over the next slot', () => {
    const { result, preventDefault } = runCoordinateGetter({ code: 'ArrowDown' });

    expect(result).toEqual({ x: 175, y: 320 });
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('continues from the current over slot for repeated moves', () => {
    const { result } = runCoordinateGetter({
      code: 'ArrowRight',
      overId: 'slot-1',
    });

    expect(result).toEqual({ x: 280, y: 525 });
  });

  it('keeps the current coordinates at the list boundary', () => {
    const { result } = runCoordinateGetter({ code: 'ArrowUp' });

    expect(result).toEqual({ x: 10, y: 20 });
  });

  it('ignores non-arrow keys', () => {
    const { result, preventDefault } = runCoordinateGetter({ code: 'Space' });

    expect(result).toBeUndefined();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
