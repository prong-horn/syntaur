import type { Rect } from '../mouse/registry.js';

export interface Action { key: string; label: string; onRun: () => void; enabled: boolean; }

export interface ActionButtonLayout { action: Action; rect: Rect; }

/** Cols of blank padding after a button's text and before the next cell. */
const GAP = 2;

/**
 * The full, unpadded text a button renders: `[key] Label`. This is the ONE
 * place that formats a button's text, so its length drives both the layout
 * width (below) and the actual rendered string (see ActionBar.tsx) — they
 * can never drift apart.
 */
export function buttonText(action: Pick<Action, 'key' | 'label'>): string {
  return `[${action.key}] ${action.label}`;
}

/**
 * Width of a single action cell: the full `[key] Label` text (derived from
 * the ACTUAL key length, not a hardcoded 1-char `[k]` assumption) plus a
 * 2-col gap before the next cell.
 */
export function cellWidth(action: Pick<Action, 'key' | 'label'>): number {
  return buttonText(action).length + GAP;
}

/** Pads `text` with trailing spaces (or truncates it) to exactly `width` columns. */
export function padCell(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}

/**
 * Lays out `actions` left-to-right within `barRect`, starting at `barRect.x`.
 * Each button occupies an explicit, non-overlapping `Rect` of `barRect.height`
 * so mouse x/y map 1:1 onto the rendered cells (no borders, no flex growth).
 * This is the SINGLE source of truth for button widths: ActionBar renders
 * each button into exactly `rect.width` cells and registers this identical
 * rect as its mouse hit-region, so rendered x-range and hit x-range can never
 * diverge.
 */
export function layoutActions(actions: Action[], barRect: Rect): ActionButtonLayout[] {
  let x = barRect.x;
  return actions.map((action) => {
    const width = cellWidth(action);
    const rect: Rect = { x, y: barRect.y, width, height: barRect.height };
    x += width;
    return { action, rect };
  });
}
