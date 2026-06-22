import { describe, expect, it } from 'vitest';
import { predictReset, verifyReset } from '../schedules/reset-window.js';
import type { ResetAnchor } from '../schedules/types.js';

const rolling: ResetAnchor = { windowStartIso: '2026-06-15T09:00:00Z', windowKind: 'rolling-5h' };
const weekly: ResetAnchor = { windowStartIso: '2026-06-15T00:00:00Z', windowKind: 'weekly' };

describe('reset-window', () => {
  it('predicts the 5h rolling reset', () => {
    expect(predictReset('claude', rolling)).toBe('2026-06-15T14:00:00Z');
  });

  it('predicts the weekly reset', () => {
    expect(predictReset('codex', weekly)).toBe('2026-06-22T00:00:00Z');
  });

  it('reports not-eligible before the predicted reset', () => {
    // verifyReset surfaces only `eligible`; the predicted next-fire is surfaced
    // by evaluateAfterReset (see schedules-triggers.test.ts), not here.
    const v = verifyReset('claude', rolling, new Date('2026-06-15T13:59:59Z'));
    expect(v.eligible).toBe(false);
  });

  it('is eligible at or after the predicted reset', () => {
    expect(verifyReset('claude', rolling, new Date('2026-06-15T14:00:00Z')).eligible).toBe(true);
    expect(verifyReset('claude', rolling, new Date('2026-06-15T20:00:00Z')).eligible).toBe(true);
  });

  it('throws on a malformed anchor', () => {
    expect(() => predictReset('claude', { windowStartIso: 'not-a-date', windowKind: 'rolling-5h' })).toThrow();
  });
});
