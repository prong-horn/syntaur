import { describe, it, expect } from 'vitest';
import { windowTreeRows } from '../TreeView.js';

describe('windowTreeRows', () => {
  it('shows everything when content fits within the viewport', () => {
    expect(windowTreeRows(5, 2, 10)).toEqual({ start: 0, end: 5 });
  });

  it('centers the window on the cursor', () => {
    // viewportHeight=10, half=5; cursor=50 -> start=45, end=55
    expect(windowTreeRows(100, 50, 10)).toEqual({ start: 45, end: 55 });
  });

  it('clamps the window to the top when the cursor is near the start', () => {
    expect(windowTreeRows(100, 2, 10)).toEqual({ start: 0, end: 10 });
  });

  it('clamps the window to the bottom when the cursor is near the end', () => {
    expect(windowTreeRows(100, 98, 10)).toEqual({ start: 90, end: 100 });
  });
});
