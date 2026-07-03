import { describe, it, expect } from 'vitest';
import { computeLayout, inset } from '../layout.js';

describe('computeLayout', () => {
  it('two columns wide; rail 28..40; action bar on last row; bordered (not tiny)', () => {
    const l = computeLayout(120, 40);
    expect(l.columns).toBe(2);
    expect(l.borderless).toBe(false);
    expect(l.railWidth).toBeGreaterThanOrEqual(28);
    expect(l.railWidth).toBeLessThanOrEqual(40);
    expect(l.regions.actionBar).toEqual({ x: 0, y: 39, width: 120, height: 1 });
    expect(l.regions.sessions.frame.x).toBe(0);
    expect(l.regions.tree.frame.x).toBe(0);
    expect(l.regions.detail.frame.x).toBe(l.railWidth);
    // Sessions stacked above tree, both within the rail's frame height.
    expect(l.regions.sessions.frame.height + l.regions.tree.frame.height).toBe(39);
    expect(l.regions.tree.frame.y).toBe(l.regions.sessions.frame.height);
  });

  it('single column below 80 cols', () => {
    const l = computeLayout(70, 30);
    expect(l.columns).toBe(1);
    expect(l.regions.sessions.frame.width).toBe(70);
    expect(l.regions.tree.frame.width).toBe(70);
  });

  it('borderless below 50 cols: content rect equals frame for every pane', () => {
    const l = computeLayout(40, 24);
    expect(l.borderless).toBe(true);
    expect(l.regions.sessions.content).toEqual(l.regions.sessions.frame);
    expect(l.regions.tree.content).toEqual(l.regions.tree.frame);
    expect(l.regions.detail.content).toEqual(l.regions.detail.frame);
  });

  it('bordered (>=50 cols): content is inset by 1 from frame', () => {
    const l = computeLayout(120, 40);
    expect(l.regions.detail.content).toEqual(inset(l.regions.detail.frame, 1));
    expect(l.regions.detail.content.x).toBe(l.regions.detail.frame.x + 1);
    expect(l.regions.detail.content.width).toBe(l.regions.detail.frame.width - 2);
  });
});

describe('inset', () => {
  it('insets each side by n', () => {
    expect(inset({ x: 0, y: 0, width: 10, height: 10 }, 1)).toEqual({ x: 1, y: 1, width: 8, height: 8 });
  });

  it('returns the rect unchanged when too small to inset (tiny-terminal safety)', () => {
    expect(inset({ x: 0, y: 0, width: 2, height: 5 }, 1)).toEqual({ x: 0, y: 0, width: 2, height: 5 });
    expect(inset({ x: 0, y: 0, width: 5, height: 2 }, 1)).toEqual({ x: 0, y: 0, width: 5, height: 2 });
  });
});
