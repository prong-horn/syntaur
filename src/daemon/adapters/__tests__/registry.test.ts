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

  it('the fallback adapter derives no opinion (empty object), never throws', () => {
    for (const agent of ['pi', 'shell', 'my-tool', '', 'CLAUDE']) {
      const adapter = resolveAdapter(agent);
      expect(() => adapter.deriveState(sampleInput)).not.toThrow();
      expect(adapter.deriveState(sampleInput)).toEqual({});
    }
  });

  it('completion criteria: resolveAdapter("anything-unknown").deriveState(...) returns {} without throwing', () => {
    expect(() => resolveAdapter('anything-unknown').deriveState(sampleInput)).not.toThrow();
    expect(resolveAdapter('anything-unknown').deriveState(sampleInput)).toEqual({});
  });

  it('resolution is deterministic: the same key always resolves to an equivalent adapter', () => {
    const first = resolveAdapter('some-novel-agent');
    const second = resolveAdapter('some-novel-agent');
    expect(first.id).toBe(second.id);
    expect(first.deriveState(sampleInput)).toEqual(second.deriveState(sampleInput));
  });

  // No agent is registered in the Map at Task 4's time (T5/T7/T8 add entries
  // later), so 'claude'/'codex' are indistinguishable from any other unknown
  // string today — this documents that, and will start failing (correctly)
  // once Tasks 7/8 register real adapters, signalling the registry is wired.
  it('agent kinds reserved for later tasks fall back to generic until registered', () => {
    expect(resolveAdapter('claude').id).toBe('generic');
    expect(resolveAdapter('codex').id).toBe('generic');
  });
});
