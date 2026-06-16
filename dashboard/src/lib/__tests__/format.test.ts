import { describe, it, expect } from 'vitest';
import { formatCost, formatTokens } from '../format';

describe('formatCost', () => {
  it('groups thousands and shows 2 decimals for amounts >= $1', () => {
    expect(formatCost(2501.9671)).toBe('$2,501.97');
    expect(formatCost(22.0373)).toBe('$22.04');
    expect(formatCost(1)).toBe('$1.00');
  });

  it('keeps up to 4 decimals for sub-dollar values so cents fractions survive', () => {
    expect(formatCost(0.0373)).toBe('$0.0373');
    expect(formatCost(0.5)).toBe('$0.50');
  });

  it('renders exact zero as $0.00', () => {
    expect(formatCost(0)).toBe('$0.00');
  });

  it('is defensive against non-finite input', () => {
    expect(formatCost(Number.NaN)).toBe('$0.00');
    expect(formatCost(Number.POSITIVE_INFINITY)).toBe('$0.00');
  });
});

describe('formatTokens', () => {
  it('groups thousands', () => {
    expect(formatTokens(3175604336)).toBe('3,175,604,336');
    expect(formatTokens(0)).toBe('0');
  });
});
