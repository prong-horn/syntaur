import { describe, it, expect } from 'vitest';
import { compareSemver } from '../utils/npx-prompt.js';

describe('compareSemver', () => {
  it('returns 0 for identical versions', () => {
    expect(compareSemver('0.1.14', '0.1.14')).toBe(0);
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
  });

  it('returns 1 when a is newer at patch level', () => {
    expect(compareSemver('0.1.15', '0.1.14')).toBe(1);
  });

  it('returns -1 when a is older at patch level', () => {
    expect(compareSemver('0.1.13', '0.1.14')).toBe(-1);
  });

  it('prioritizes major > minor > patch', () => {
    expect(compareSemver('1.0.0', '0.99.99')).toBe(1);
    expect(compareSemver('0.2.0', '0.1.99')).toBe(1);
    expect(compareSemver('0.1.0', '0.0.99')).toBe(1);
  });

  it('pads missing segments with zero', () => {
    expect(compareSemver('1.0', '1.0.0')).toBe(0);
    expect(compareSemver('1', '1.0.0')).toBe(0);
    expect(compareSemver('1.1', '1.0.9')).toBe(1);
  });

  it('strips pre-release and build metadata', () => {
    expect(compareSemver('1.2.3-beta.1', '1.2.3')).toBe(0);
    expect(compareSemver('1.2.3+build.42', '1.2.3')).toBe(0);
    expect(compareSemver('1.2.4-rc.1', '1.2.3')).toBe(1);
  });

  it('returns 0 for unparseable input (safe fallback)', () => {
    expect(compareSemver('not-a-version', '1.0.0')).toBe(0);
    expect(compareSemver('1.0.0', '')).toBe(0);
    expect(compareSemver('', '')).toBe(0);
  });
});
