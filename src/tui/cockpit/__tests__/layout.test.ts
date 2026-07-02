import { describe, it, expect } from 'vitest';
import { computeLayout } from '../layout.js';

describe('computeLayout', () => {
  it('two columns wide; rail 28..40; action bar on last row', () => {
    const l = computeLayout(120, 40);
    expect(l.columns).toBe(2);
    expect(l.railWidth).toBeGreaterThanOrEqual(28);
    expect(l.railWidth).toBeLessThanOrEqual(40);
    expect(l.regions.actionBar).toEqual({ x: 0, y: 39, width: 120, height: 1 });
    expect(l.regions.rail.x).toBe(0);
    expect(l.regions.detail.x).toBe(l.railWidth);
    expect(l.regions.rail.height).toBe(39);
  });
  it('single column below 80 cols', () => {
    const l = computeLayout(70, 30);
    expect(l.columns).toBe(1);
    expect(l.regions.rail.width).toBe(70);
  });
});
