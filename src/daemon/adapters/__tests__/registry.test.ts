import { describe, expect, it } from 'vitest';
import type { DeriveInput } from '../../types.js';
import { resolveAdapter } from '../registry.js';

const sampleInput: DeriveInput = {
  screen: { lines: ['hello'], cols: 80, rows: 24 },
  hookEvents: [],
  procAlive: true,
  outputIdleMs: 0,
  cwd: '/tmp',
  nowMs: 0,
};

describe('resolveAdapter', () => {
  it('resolves an unknown/novel agent string to the generic fallback', () => {
    const adapter = resolveAdapter('anything-unknown');
    expect(adapter.id).toBe('generic');
  });

  it('the fallback adapter derives a working opinion on a normal screen, never throws', () => {
    for (const agent of ['pi', 'shell', 'my-tool', '', 'CLAUDE']) {
      const adapter = resolveAdapter(agent);
      expect(() => adapter.deriveState(sampleInput)).not.toThrow();
      expect(adapter.deriveState(sampleInput)).toEqual({ state: 'working', needs: null });
    }
  });

  it('completion criteria: resolveAdapter("anything-unknown").deriveState(...) resolves without throwing', () => {
    expect(() => resolveAdapter('anything-unknown').deriveState(sampleInput)).not.toThrow();
    expect(resolveAdapter('anything-unknown').deriveState(sampleInput)).toEqual({
      state: 'working',
      needs: null,
    });
  });

  it('resolution is deterministic: the same key always resolves to an equivalent adapter', () => {
    const first = resolveAdapter('some-novel-agent');
    const second = resolveAdapter('some-novel-agent');
    expect(first.id).toBe(second.id);
    expect(first.deriveState(sampleInput)).toEqual(second.deriveState(sampleInput));
  });
});
