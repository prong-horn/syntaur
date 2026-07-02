import type { Rect } from '../mouse/registry.js';

export type FocusTarget = 'rail' | 'detail';
export interface CockpitRegions { rail: Rect; detail: Rect; actionBar: Rect; }
export interface CockpitLayout {
  columns: 1 | 2;
  railWidth: number;
  columnsTotal: number;
  rowsTotal: number;
  regions: CockpitRegions;
}

export function computeLayout(columns: number, rows: number): CockpitLayout {
  const bodyHeight = Math.max(1, rows - 1);
  const actionBar: Rect = { x: 0, y: rows - 1, width: columns, height: 1 };

  if (columns < 80) {
    const railHeight = Math.floor(bodyHeight / 2);
    return {
      columns: 1, railWidth: columns, columnsTotal: columns, rowsTotal: rows,
      regions: {
        rail: { x: 0, y: 0, width: columns, height: railHeight },
        detail: { x: 0, y: railHeight, width: columns, height: bodyHeight - railHeight },
        actionBar,
      },
    };
  }
  const railWidth = Math.min(40, Math.max(28, Math.floor(columns * 0.28)));
  return {
    columns: 2, railWidth, columnsTotal: columns, rowsTotal: rows,
    regions: {
      rail: { x: 0, y: 0, width: railWidth, height: bodyHeight },
      detail: { x: railWidth, y: 0, width: columns - railWidth, height: bodyHeight },
      actionBar,
    },
  };
}
