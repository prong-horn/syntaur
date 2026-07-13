import type { Rect } from '../mouse/registry.js';

export type FocusTarget = 'rail' | 'tree' | 'detail';

/** Below this column count, chrome (borders/titles) is dropped — see `borderless`. */
const BORDERLESS_BELOW_COLS = 50;

export interface FrameContent {
  /** The full pane rect, including where a border (if any) is drawn. */
  frame: Rect;
  /** The rect content renders into and mouse regions register against — `inset(frame, 1)` when bordered, else identical to `frame`. */
  content: Rect;
  /** True when THIS pane skips its border — the global column rule, or a frame too short/narrow for `inset(frame, 1)` to actually shrink (a tiny-terminal case the global column-only rule misses). Consult this per-pane flag when deciding whether to draw a border, never the top-level `CockpitLayout.borderless` alone. */
  borderless: boolean;
}

export interface CockpitRegions {
  sessions: FrameContent;
  tree: FrameContent;
  detail: FrameContent;
  /** Fixed row for launch/attach outcome text, directly above the action bar — replaces the old Detail-title status hijack. */
  statusRow: Rect;
  actionBar: Rect;
}

export interface CockpitLayout {
  columns: 1 | 2;
  railWidth: number;
  columnsTotal: number;
  rowsTotal: number;
  /** True below `BORDERLESS_BELOW_COLS` — Cockpit skips `borderStyle` and hit rects use `frame` directly (no inset). */
  borderless: boolean;
  regions: CockpitRegions;
}

/**
 * Insets a rect by `n` on every side. Returns the rect UNCHANGED (never a
 * negative/zero-size rect) when it's too small to accommodate the inset —
 * the safety fallback that makes tiny-terminal degradation automatic: a rect
 * too small to border still gets a usable content rect equal to its frame.
 */
export function inset(rect: Rect, n: number): Rect {
  if (rect.width <= n * 2 || rect.height <= n * 2) return rect;
  return { x: rect.x + n, y: rect.y + n, width: rect.width - n * 2, height: rect.height - n * 2 };
}

function frameContent(frame: Rect, globalBorderless: boolean): FrameContent {
  // A frame too short/narrow for `inset(frame, 1)` to actually shrink it
  // (height or width <= 2) must also go borderless — otherwise the border
  // still draws while `content === frame` (inset's no-op safety), and the
  // rendered border row/col would desync from the mouse hit-rect.
  const laneBorderless = globalBorderless || frame.width <= 2 || frame.height <= 2;
  return { frame, content: laneBorderless ? frame : inset(frame, 1), borderless: laneBorderless };
}

/** Splits a rail column into a Sessions area (top, capped share) and a Projects tree area (rest). */
function splitRail(railFrame: Rect): { sessions: Rect; tree: Rect } {
  const sessionsHeight = Math.max(1, Math.min(Math.floor(railFrame.height * 0.4), railFrame.height - 1));
  const treeHeight = Math.max(1, railFrame.height - sessionsHeight);
  return {
    sessions: { x: railFrame.x, y: railFrame.y, width: railFrame.width, height: sessionsHeight },
    tree: { x: railFrame.x, y: railFrame.y + sessionsHeight, width: railFrame.width, height: treeHeight },
  };
}

export function computeLayout(columns: number, rows: number): CockpitLayout {
  const borderless = columns < BORDERLESS_BELOW_COLS;
  // Bottom two rows are fixed chrome: the status line, then the action bar.
  const bodyHeight = Math.max(1, rows - 2);
  const statusRow: Rect = { x: 0, y: Math.max(0, rows - 2), width: columns, height: 1 };
  const actionBar: Rect = { x: 0, y: Math.max(0, rows - 1), width: columns, height: 1 };

  if (columns < 80) {
    const railHeight = Math.floor(bodyHeight / 2);
    const railFrame: Rect = { x: 0, y: 0, width: columns, height: railHeight };
    const detailFrame: Rect = { x: 0, y: railHeight, width: columns, height: bodyHeight - railHeight };
    const { sessions, tree } = splitRail(railFrame);
    return {
      columns: 1, railWidth: columns, columnsTotal: columns, rowsTotal: rows, borderless,
      regions: {
        sessions: frameContent(sessions, borderless),
        tree: frameContent(tree, borderless),
        detail: frameContent(detailFrame, borderless),
        statusRow,
        actionBar,
      },
    };
  }
  const railWidth = Math.min(40, Math.max(28, Math.floor(columns * 0.28)));
  const railFrame: Rect = { x: 0, y: 0, width: railWidth, height: bodyHeight };
  const detailFrame: Rect = { x: railWidth, y: 0, width: columns - railWidth, height: bodyHeight };
  const { sessions, tree } = splitRail(railFrame);
  return {
    columns: 2, railWidth, columnsTotal: columns, rowsTotal: rows, borderless,
    regions: {
      sessions: frameContent(sessions, borderless),
      tree: frameContent(tree, borderless),
      detail: frameContent(detailFrame, borderless),
      statusRow,
      actionBar,
    },
  };
}
