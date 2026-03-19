import { describe, it, expect } from 'vitest';
import { nowTimestamp } from '../utils/timestamp.js';

describe('nowTimestamp', () => {
  it('returns RFC 3339 UTC format without milliseconds', () => {
    const ts = nowTimestamp();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('does not include milliseconds', () => {
    const ts = nowTimestamp();
    expect(ts).not.toContain('.');
  });

  it('ends with Z (UTC)', () => {
    const ts = nowTimestamp();
    expect(ts.endsWith('Z')).toBe(true);
  });
});
