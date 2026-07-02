import { describe, it, expect } from 'vitest';
import { enableMouseTracking, disableMouseTracking, runWithMouseSuspended } from '../tracking.js';

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

describe('runWithMouseSuspended (re-arm around suspendTerminal)', () => {
  it('disables tracking BEFORE the suspend and re-enables AFTER it resolves', async () => {
    const log: string[] = [];
    const write = (s: string) => log.push(`write:${s}`);

    await runWithMouseSuspended(write, async () => {
      log.push('suspend');
    });

    const suspendIdx = log.indexOf('suspend');
    expect(suspendIdx).toBeGreaterThan(-1);
    const before = log.slice(0, suspendIdx);
    const after = log.slice(suspendIdx + 1);
    // disable sequences use the 'l' terminator, enable uses 'h'.
    expect(before.some((l) => l.includes('1006l'))).toBe(true);
    expect(before.some((l) => l.includes('1006h'))).toBe(false);
    expect(after.some((l) => l.includes('1006h'))).toBe(true);
  });

  it('re-enables tracking even when the suspended action rejects (error path)', async () => {
    const log: string[] = [];
    const write = (s: string) => log.push(s);

    await expect(
      runWithMouseSuspended(write, async () => {
        throw new Error('attach failed');
      }),
    ).rejects.toThrow('attach failed');

    // Enable ('h') sequences were still written after the failure.
    expect(log.some((l) => l.includes('1006h'))).toBe(true);
  });
});
