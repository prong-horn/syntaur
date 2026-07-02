import { describe, it, expect } from 'vitest';
import { enableMouseTracking, disableMouseTracking } from '../tracking.js';

describe('mouse tracking mode', () => {
  it('enable writes 1000 + 1002 + 1006 set sequences', () => {
    let buf = '';
    enableMouseTracking((s) => (buf += s));
    expect(buf).toBe('\x1b[?1000h\x1b[?1002h\x1b[?1006h');
  });
  it('disable writes the resets in reverse', () => {
    let buf = '';
    disableMouseTracking((s) => (buf += s));
    expect(buf).toBe('\x1b[?1006l\x1b[?1002l\x1b[?1000l');
  });
});
