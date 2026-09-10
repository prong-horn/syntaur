import { describe, expect, it } from 'vitest';
import { parseWindow } from '../useInboxWindow';

describe('parseWindow', () => {
  it('defaults junk to 14d', () => {
    expect(parseWindow(null)).toBe('14d');
    expect(parseWindow('')).toBe('14d');
    expect(parseWindow('bogus')).toBe('14d');
  });

  it('accepts all', () => {
    expect(parseWindow('all')).toBe('all');
  });
});
