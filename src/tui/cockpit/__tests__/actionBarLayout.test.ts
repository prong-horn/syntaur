import { describe, it, expect, vi } from 'vitest';
import { cellWidth, layoutActions } from '../actionBarLayout.js';

describe('cellWidth', () => {
  it('accounts for the "[k] " prefix, the label, and a 2-col gap', () => {
    expect(cellWidth('Launch')).toBe(3 + 1 + 'Launch'.length + 2);
    expect(cellWidth('Quit')).toBe(3 + 1 + 'Quit'.length + 2);
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
    expect(layout[0].rect).toEqual({ x: 0, y: 23, width: cellWidth('Launch'), height: 1 });
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
});
