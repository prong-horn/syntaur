import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfirmAnswer } from '../utils/prompt.js';

describe('parseConfirmAnswer', () => {
  it('accepts the default on empty input', () => {
    expect(parseConfirmAnswer('', true)).toBe(true);
    expect(parseConfirmAnswer('', false)).toBe(false);
  });

  it('accepts yes and no answers case-insensitively', () => {
    expect(parseConfirmAnswer('y')).toBe(true);
    expect(parseConfirmAnswer('YES')).toBe(true);
    expect(parseConfirmAnswer('n')).toBe(false);
    expect(parseConfirmAnswer('No')).toBe(false);
  });

  it('returns null for invalid input so the caller can re-prompt', () => {
    expect(parseConfirmAnswer('maybe')).toBeNull();
    expect(parseConfirmAnswer('1')).toBeNull();
  });
});
