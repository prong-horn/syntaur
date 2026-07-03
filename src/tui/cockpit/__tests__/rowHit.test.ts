import { describe, it, expect } from 'vitest';
import { resolveRowIndex } from '../railTypes.js';

const rect = { x: 0, y: 0, width: 30, height: 10 };

describe('resolveRowIndex', () => {
  it('maps a click row to a 0-based index below the header rows', () => {
    expect(resolveRowIndex(rect, 2, 1)).toBe(1);
  });
  it('returns null on/above the header', () => {
    expect(resolveRowIndex(rect, 0, 1)).toBeNull();
  });
  it('returns null outside the rect vertically', () => {
    expect(resolveRowIndex(rect, 20, 1)).toBeNull();
  });
});
