import { describe, it, expect, vi } from 'vitest';
import { buttonText, cellWidth, padCell, layoutActions } from '../actionBarLayout.js';

describe('buttonText', () => {
  it('formats "[key] Label"', () => {
    expect(buttonText({ key: 'l', label: 'Launch' })).toBe('[l] Launch');
    expect(buttonText({ key: 'ctrl', label: 'Cancel' })).toBe('[ctrl] Cancel');
  });
});

describe('cellWidth', () => {
  it('accounts for the "[key] " prefix, the label, and a 2-col gap', () => {
    expect(cellWidth({ key: 'l', label: 'Launch' })).toBe('[l] Launch'.length + 2);
    expect(cellWidth({ key: 'q', label: 'Quit' })).toBe('[q] Quit'.length + 2);
  });

  it('derives width from the actual key length, not a hardcoded 1-char key', () => {
    // Regression: the old formula hardcoded 3 cols for "[k]" and silently
    // under-measured any multi-char key.
    expect(cellWidth({ key: 'ctrl', label: 'Launch' })).toBe('[ctrl] Launch'.length + 2);
    expect(cellWidth({ key: 'ctrl', label: 'Launch' })).not.toBe(cellWidth({ key: 'l', label: 'Launch' }));
  });
});

describe('padCell', () => {
  it('pads short text with trailing spaces to exactly width columns', () => {
    expect(padCell('[l] Launch', 15)).toBe('[l] Launch     ');
    expect(padCell('[l] Launch', 15)).toHaveLength(15);
  });

  it('truncates text longer than width', () => {
    expect(padCell('[l] Launch', 5)).toBe('[l] L');
  });
});

describe('layoutActions', () => {
  const barRect = { x: 0, y: 23, width: 80, height: 1 };
  const actions = [
    { key: 'l', label: 'Launch', onRun: vi.fn(), enabled: true },
    { key: 'a', label: 'Attach', onRun: vi.fn(), enabled: false },
    { key: 'q', label: 'Quit', onRun: vi.fn(), enabled: true },
  ];

  it('produces one rect per action, in order', () => {
    const layout = layoutActions(actions, barRect);
    expect(layout).toHaveLength(3);
    expect(layout.map((l) => l.action.key)).toEqual(['l', 'a', 'q']);
  });

  it('places the first button at barRect.x/y with barRect.height', () => {
    const layout = layoutActions(actions, barRect);
    expect(layout[0].rect).toEqual({ x: 0, y: 23, width: cellWidth(actions[0]), height: 1 });
  });

  it('lays out subsequent buttons left-to-right with no gaps or overlaps', () => {
    const layout = layoutActions(actions, barRect);
    expect(layout[1].rect.x).toBe(layout[0].rect.x + layout[0].rect.width);
    expect(layout[2].rect.x).toBe(layout[1].rect.x + layout[1].rect.width);
  });

  it('offsets from a non-zero barRect origin', () => {
    const layout = layoutActions([actions[2]], { x: 10, y: 5, width: 40, height: 1 });
    expect(layout[0].rect.x).toBe(10);
    expect(layout[0].rect.y).toBe(5);
  });

  it('sizes a multi-char-key button using its own key length', () => {
    const withCtrl = layoutActions([{ key: 'ctrl', label: 'Cancel', onRun: vi.fn(), enabled: true }], barRect);
    expect(withCtrl[0].rect.width).toBe('[ctrl] Cancel'.length + 2);
  });
});
