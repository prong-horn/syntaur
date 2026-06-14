import { describe, expect, it } from 'vitest';
import { nextSlotId, addSlot, removeSlot } from '../../dashboard/src/pages/overview-slots';
import {
  resolveGeometry,
  scaleSpan,
  activeColumnsForWidth,
  pxToCols,
  pxToRows,
  ROW_HEIGHT_PX,
  SIZE_PRESETS,
  HSHORT,
  HTALL,
} from '../../dashboard/src/pages/overview-geometry';
import type { DashboardSlot } from '../../src/utils/saved-views-schema';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeSlots(ids: string[]): DashboardSlot[] {
  return ids.map((id) => ({ id, widget: null }));
}

// ---------------------------------------------------------------------------
// nextSlotId
// ---------------------------------------------------------------------------

describe('nextSlotId', () => {
  it('returns slot-0 for empty array', () => {
    expect(nextSlotId([])).toBe('slot-0');
  });

  it('returns slot-2 for sequential [slot-0, slot-1]', () => {
    expect(nextSlotId(makeSlots(['slot-0', 'slot-1']))).toBe('slot-2');
  });

  it('is monotonic: [slot-0, slot-2] → slot-3 (no collision, skips gap)', () => {
    expect(nextSlotId(makeSlots(['slot-0', 'slot-2']))).toBe('slot-3');
  });

  it('handles a set containing slot-5 and a uuid → slot-6', () => {
    const slots = makeSlots(['slot-5', '550e8400-e29b-41d4-a716-446655440000']);
    expect(nextSlotId(slots)).toBe('slot-6');
  });

  it('falls back to slot-0 when no ids conform to slot-N pattern', () => {
    expect(nextSlotId(makeSlots(['abc', 'def']))).toBe('slot-0');
  });
});

// ---------------------------------------------------------------------------
// addSlot
// ---------------------------------------------------------------------------

describe('addSlot', () => {
  it('appends one empty slot with the next id and widget: null', () => {
    const slots = makeSlots(['slot-0']);
    const result = addSlot(slots);
    expect(result).toHaveLength(2);
    expect(result[1].id).toBe('slot-1');
    expect(result[1].widget).toBeNull();
  });

  it('does not mutate the input array', () => {
    const slots = makeSlots(['slot-0']);
    addSlot(slots);
    expect(slots).toHaveLength(1);
  });

  it('attaches the size geometry when geometry arg is provided', () => {
    const geo = { w: 12, h: 20 };
    const result = addSlot([], geo);
    expect(result[0].size).toEqual(geo);
  });

  it('does NOT add a size property when geometry is omitted', () => {
    const result = addSlot([]);
    expect(result[0]).not.toHaveProperty('size');
  });
});

// ---------------------------------------------------------------------------
// removeSlot
// ---------------------------------------------------------------------------

describe('removeSlot', () => {
  it('removes the slot with the given id', () => {
    const slots = makeSlots(['slot-0', 'slot-1', 'slot-2']);
    const result = removeSlot(slots, 'slot-1');
    expect(result.map((s) => s.id)).toEqual(['slot-0', 'slot-2']);
    expect(result).toHaveLength(2);
  });

  it('does not mutate the input array', () => {
    const slots = makeSlots(['slot-0', 'slot-1']);
    removeSlot(slots, 'slot-0');
    expect(slots).toHaveLength(2);
  });

  it('unknown id returns a new array equal in contents to the input', () => {
    const slots = makeSlots(['slot-0', 'slot-1']);
    const result = removeSlot(slots, 'slot-99');
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.id)).toEqual(['slot-0', 'slot-1']);
    expect(result).not.toBe(slots); // new array, not the same reference
  });
});

// ---------------------------------------------------------------------------
// resolveGeometry
// ---------------------------------------------------------------------------

describe('resolveGeometry', () => {
  it('small → { w: 8, h: HSHORT }', () => {
    expect(resolveGeometry('small')).toEqual({ w: 8, h: HSHORT });
  });

  it('wide → { w: 16, h: HSHORT }', () => {
    expect(resolveGeometry('wide')).toEqual({ w: 16, h: HSHORT });
  });

  it('tall → { w: 8, h: HTALL }', () => {
    expect(resolveGeometry('tall')).toEqual({ w: 8, h: HTALL });
  });

  it('large → { w: 16, h: HTALL }', () => {
    expect(resolveGeometry('large')).toEqual({ w: 16, h: HTALL });
  });

  it('undefined → { w: 8, h: 16 }', () => {
    expect(resolveGeometry(undefined)).toEqual({ w: 8, h: 16 });
  });

  it('a passed geometry {w:13,h:7} returns unchanged', () => {
    const geo = { w: 13, h: 7 };
    expect(resolveGeometry(geo)).toEqual(geo);
  });
});

// ---------------------------------------------------------------------------
// scaleSpan
// ---------------------------------------------------------------------------

describe('scaleSpan', () => {
  it('scaleSpan(24, 24) === 24', () => expect(scaleSpan(24, 24)).toBe(24));
  it('scaleSpan(8, 24) === 8', () => expect(scaleSpan(8, 24)).toBe(8));
  it('scaleSpan(24, 12) === 12', () => expect(scaleSpan(24, 12)).toBe(12));
  it('scaleSpan(8, 12) === 4', () => expect(scaleSpan(8, 12)).toBe(4));
  it('scaleSpan(8, 1) === 1 (clamps to ≥1)', () => expect(scaleSpan(8, 1)).toBe(1));
  it('scaleSpan(1, 24) === 1', () => expect(scaleSpan(1, 24)).toBe(1));
  it('scaleSpan(8, 0) === 1 (zero column guard)', () => expect(scaleSpan(8, 0)).toBe(1));
  it('scaleSpan(8, -5) === 1 (negative column guard)', () => expect(scaleSpan(8, -5)).toBe(1));
});

// ---------------------------------------------------------------------------
// activeColumnsForWidth
// ---------------------------------------------------------------------------

describe('activeColumnsForWidth', () => {
  const cases: [number, number][] = [
    [1280, 24],
    [1300, 24],
    [1279, 16],
    [1024, 16],
    [1023, 12],
    [768, 12],
    [767, 6],
    [640, 6],
    [639, 1],
    [320, 1],
    [0, 1],
  ];
  for (const [width, expected] of cases) {
    it(`width ${width} → ${expected} columns`, () => {
      expect(activeColumnsForWidth(width)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// pxToCols
// ---------------------------------------------------------------------------

describe('pxToCols', () => {
  it('pxToCols(100, 50) === 2', () => expect(pxToCols(100, 50)).toBe(2));
  it('rounds down: pxToCols(74, 50) === 1', () => expect(pxToCols(74, 50)).toBe(1));
  it('rounds up: pxToCols(76, 50) === 2', () => expect(pxToCols(76, 50)).toBe(2));
  it('negative delta: pxToCols(-100, 50) === -2', () => expect(pxToCols(-100, 50)).toBe(-2));
  it('colWidthPx === 0 → 0', () => expect(pxToCols(100, 0)).toBe(0));
});

// ---------------------------------------------------------------------------
// pxToRows
// ---------------------------------------------------------------------------

describe('pxToRows', () => {
  it('pxToRows(100, 20) === 5', () => expect(pxToRows(100, 20)).toBe(5));
  it('rounds: pxToRows(110, 20) === 6', () => expect(pxToRows(110, 20)).toBe(6));
  it('uses ROW_HEIGHT_PX default: pxToRows(40) === 2', () => {
    expect(ROW_HEIGHT_PX).toBe(20);
    expect(pxToRows(40)).toBe(2);
  });
  it('negative drag: pxToRows(-110, 20) === -5 (Math.round(-5.5) === -5 in JS)', () => {
    // -110 / 20 = -5.5; JS Math.round rounds toward +∞ on .5 ties, so Math.round(-5.5) = -5
    expect(pxToRows(-110, 20)).toBe(-5);
  });
  it('negative drag default rowHeight: pxToRows(-30) === -1 (Math.round(-1.5) === -1 in JS)', () => {
    // -30 / 20 = -1.5; JS Math.round(-1.5) = -1 (rounds toward +∞)
    expect(pxToRows(-30)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// SIZE_PRESETS
// ---------------------------------------------------------------------------

describe('SIZE_PRESETS', () => {
  it('is non-empty', () => expect(SIZE_PRESETS.length).toBeGreaterThan(0));

  it('every entry has integer w in [1,24]', () => {
    for (const preset of SIZE_PRESETS) {
      expect(Number.isInteger(preset.w)).toBe(true);
      expect(preset.w).toBeGreaterThanOrEqual(1);
      expect(preset.w).toBeLessThanOrEqual(24);
    }
  });

  it('every entry has integer h in [1,60]', () => {
    for (const preset of SIZE_PRESETS) {
      expect(Number.isInteger(preset.h)).toBe(true);
      expect(preset.h).toBeGreaterThanOrEqual(1);
      expect(preset.h).toBeLessThanOrEqual(60);
    }
  });
});
