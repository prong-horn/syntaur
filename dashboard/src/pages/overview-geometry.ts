import { GRID_COLUMNS, MAX_ROWS, isWidgetGeometry } from '@shared/saved-views-schema';
import type { WidgetGeometry, WidgetSize } from '@shared/saved-views-schema';

export { MAX_ROWS };

export const ROW_HEIGHT_PX = 20;
export const GRID_GAP_PX = 16; // Grid gap in px (matches the 1rem CSS gap). Exported for consumers that derive column width from container width.

export const MIN_ROWS = 2; // Minimum widget height in row units (used to clamp drag-to-resize).

// Legacy enum heights in row units, approximating today's ~320px / ~560px cards at ROW_HEIGHT_PX.
// (320/20 = 16, 560/20 = 28) — module-internal, but export so tests/UI can reference.
export const HSHORT = 16;
export const HTALL = 28;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export const BREAKPOINT_COLUMNS: ReadonlyArray<{ minWidth: number; columns: number }> = [
  { minWidth: 1280, columns: 24 }, // 24 === GRID_COLUMNS
  { minWidth: 1024, columns: 16 },
  { minWidth: 768, columns: 12 },
  { minWidth: 640, columns: 6 },
  { minWidth: 0, columns: 1 },
];

export function activeColumnsForWidth(width: number): number {
  if (!Number.isFinite(width) || width < 0) return 1;
  for (const entry of BREAKPOINT_COLUMNS) {
    if (width >= entry.minWidth) return entry.columns;
  }
  return 1;
}

export function scaleSpan(w: number, activeColumns: number): number {
  if (activeColumns <= 0) return 1;
  return clamp(Math.round((w / GRID_COLUMNS) * activeColumns), 1, activeColumns);
}

export function resolveGeometry(size: WidgetSize | WidgetGeometry | undefined): WidgetGeometry {
  if (isWidgetGeometry(size)) return size;
  switch (size) {
    case 'small':
      return { w: 8, h: HSHORT };
    case 'wide':
      return { w: 16, h: HSHORT };
    case 'tall':
      return { w: 8, h: HTALL };
    case 'large':
      return { w: 16, h: HTALL };
    default:
      // undefined (absent size — back-compat) or any unknown value
      return { w: 8, h: HSHORT };
  }
}

export function pxToCols(dx: number, colWidthPx: number): number {
  return colWidthPx > 0 ? Math.round(dx / colWidthPx) : 0;
}

export function pxToRows(dy: number, rowHeightPx = ROW_HEIGHT_PX): number {
  return Math.round(dy / rowHeightPx);
}

export interface SizePreset {
  label: string;
  w: number;
  h: number;
}

export const SIZE_PRESETS: readonly SizePreset[] = [
  { label: 'Third', w: 8, h: HSHORT },
  { label: 'Half', w: 12, h: HSHORT },
  { label: 'Two-thirds', w: 16, h: HSHORT },
  { label: 'Full', w: 24, h: HSHORT },
  { label: 'Half tall', w: 12, h: HTALL },
  { label: 'Full tall', w: 24, h: HTALL },
];
