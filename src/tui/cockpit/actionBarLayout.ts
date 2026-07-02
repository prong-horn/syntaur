import type { Rect } from '../mouse/registry.js';

export interface Action { key: string; label: string; onRun: () => void; enabled: boolean; }

export interface ActionButtonLayout { action: Action; rect: Rect; }

/**
 * Width of a single action cell rendered as `[k] Label` followed by a 2-col
 * gap before the next cell: 3 cols for `[k]`, 1 space, the label, 2 cols gap.
 */
export function cellWidth(label: string): number {
  return 3 + 1 + label.length + 2;
}

/**
 * Lays out `actions` left-to-right within `barRect`, starting at `barRect.x`.
 * Each button occupies an explicit, non-overlapping `Rect` of `barRect.height`
 * so mouse x/y map 1:1 onto the rendered cells (no borders, no flex growth).
 */
export function layoutActions(actions: Action[], barRect: Rect): ActionButtonLayout[] {
  let x = barRect.x;
  return actions.map((action) => {
    const width = cellWidth(action.label);
    const rect: Rect = { x, y: barRect.y, width, height: barRect.height };
    x += width;
    return { action, rect };
  });
}
