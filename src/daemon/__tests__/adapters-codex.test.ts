// Codex has no rich hook system: the only signals fixtured here are the
// `notify` turn-boundary event (schema unverified upstream — existence + `at`
// recency IS the signal, D6), rollout-log recency (injected via
// `createCodexAdapter(fakeProbe)` so no test ever touches real fs state under
// `~/.codex`), and generic screen heuristics as the degraded-mode floor.
// Fixtures are time-coherent: notify `at` stamps are derived from
// `FIXED_NOW`/`outputIdleMs` so `lastOutputAtMs` vs notify recency is pinned
// explicitly per case (review r3 F2's de-latch semantics).
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeriveInput, HookEvent } from '../types.js';
import { createCodexAdapter, defaultRolloutProbe } from '../adapters/codex.js';
import type { RolloutProbe } from '../adapters/codex.js';
import { resolveAdapter } from '../adapters/registry.js';

const FIXED_NOW = 1_700_000_000_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function notify(at: number, payload: unknown = { type: 'agent-turn-complete' }): HookEvent {
  return { event: 'notify', at: iso(at), payload };
}

interface InputOverrides {
  hookEvents?: HookEvent[];
  lines?: string[];
  idle?: number;
  cwd?: string;
  nowMs?: number;
}

function input(over: InputOverrides = {}): DeriveInput {
  return {
    screen: { lines: over.lines ?? ['$ codex'], cols: 80, rows: 24 },
    hookEvents: over.hookEvents ?? [],
    procAlive: true,
    outputIdleMs: over.idle ?? 0,
    cwd: over.cwd ?? '/w',
    nowMs: over.nowMs ?? FIXED_NOW,
  };
}

const staleProbe: RolloutProbe = () => 600_000;
const freshProbe: RolloutProbe = () => 1000;
const nullProbe: RolloutProbe = () => null;
const throwingProbe: RolloutProbe = () => {
  throw new Error('probe boom');
};

describe('codexAdapter.deriveState', () => {
  it('(a) ACTIVE notify + idle 60000 + stale rollout -> blocked, awaiting input', () => {
    const idle = 60_000;
    const lastOutputAtMs = FIXED_NOW - idle;
    const adapter = createCodexAdapter(staleProbe);
    const result = adapter.deriveState(
      input({ hookEvents: [notify(lastOutputAtMs)], idle }),
    );
    expect(result).toEqual({ state: 'blocked', needs: 'awaiting input' });
  });

  it('(b) ACTIVE notify + idle 500 -> working (still printing the turn-end banner)', () => {
    const idle = 500;
    const lastOutputAtMs = FIXED_NOW - idle;
    const adapter = createCodexAdapter(staleProbe);
    const result = adapter.deriveState(
      input({ hookEvents: [notify(lastOutputAtMs)], idle }),
    );
    expect(result).toEqual({ state: 'working', needs: null });
  });

  it('(c) ACTIVE notify + idle 60000 + fresh rollout -> working (thinking silently)', () => {
    const idle = 60_000;
    const lastOutputAtMs = FIXED_NOW - idle;
    const adapter = createCodexAdapter(freshProbe);
    const result = adapter.deriveState(
      input({ hookEvents: [notify(lastOutputAtMs)], idle }),
    );
    expect(result).toEqual({ state: 'working', needs: null });
  });

  it('(d) ACTIVE notify + probe null (no rollout found) + idle 60000 -> blocked (notify alone suffices)', () => {
    const idle = 60_000;
    const lastOutputAtMs = FIXED_NOW - idle;
    const adapter = createCodexAdapter(nullProbe);
    const result = adapter.deriveState(
      input({ hookEvents: [notify(lastOutputAtMs)], idle }),
    );
    expect(result).toEqual({ state: 'blocked', needs: 'awaiting input' });
  });

  it('(e) DEGRADED (no notify): prompt screen + idle 5000 + stale rollout -> blocked via generic', () => {
    const adapter = createCodexAdapter(staleProbe);
    const result = adapter.deriveState(input({ lines: ['Proceed? [y/N]'], idle: 5000 }));
    expect(result).toEqual({ state: 'blocked', needs: 'confirm [y/N]' });
  });

  it('(f) DEGRADED: same prompt screen + fresh rollout -> working (rollout veto)', () => {
    const adapter = createCodexAdapter(freshProbe);
    const result = adapter.deriveState(input({ lines: ['Proceed? [y/N]'], idle: 5000 }));
    expect(result).toEqual({ state: 'working', needs: null });
  });

  it('(g) DEGRADED: normal screen -> working', () => {
    const adapter = createCodexAdapter(staleProbe);
    const result = adapter.deriveState(input({ lines: ['just some output'], idle: 0 }));
    expect(result).toEqual({ state: 'working', needs: null });
  });

  it("(h) junk notify payload ({raw: '<<<'}) is still a turn signal: same outcome as (a)", () => {
    const idle = 60_000;
    const lastOutputAtMs = FIXED_NOW - idle;
    const adapter = createCodexAdapter(staleProbe);
    const result = adapter.deriveState(
      input({ hookEvents: [notify(lastOutputAtMs, { raw: '<<<' })], idle }),
    );
    expect(result).toEqual({ state: 'blocked', needs: 'awaiting input' });
  });

  it("(i) probe throws -> treated as null; (d)'s expectations hold", () => {
    const idle = 60_000;
    const lastOutputAtMs = FIXED_NOW - idle;
    const adapter = createCodexAdapter(throwingProbe);
    const result = adapter.deriveState(
      input({ hookEvents: [notify(lastOutputAtMs)], idle }),
    );
    expect(result).toEqual({ state: 'blocked', needs: 'awaiting input' });
  });

  describe('(j) defaultRolloutProbe integration (redirected CODEX_SESSIONS_DIR, never touches real ~/.codex)', () => {
    let tmpRoot: string | null = null;
    const originalEnv = process.env.CODEX_SESSIONS_DIR;

    afterEach(() => {
      if (originalEnv === undefined) delete process.env.CODEX_SESSIONS_DIR;
      else process.env.CODEX_SESSIONS_DIR = originalEnv;
      if (tmpRoot !== null) {
        rmSync(tmpRoot, { recursive: true, force: true });
        tmpRoot = null;
      }
    });

    it('resolves a matching rollout by cwd, returns null for a non-matching cwd, and invalidates its cache when the file vanishes', () => {
      tmpRoot = mkdtempSync(join(tmpdir(), 'codex-sessions-'));
      const dayDir = join(tmpRoot, '2026', '07', '19');
      mkdirSync(dayDir, { recursive: true });
      const rolloutPath = join(dayDir, 'rollout-x.jsonl');
      const line1 = JSON.stringify({
        timestamp: iso(FIXED_NOW),
        type: 'session_meta',
        payload: { id: 'u1', cwd: '/match' },
      });
      writeFileSync(rolloutPath, `${line1}\n{"type":"other"}\n`);
      process.env.CODEX_SESSIONS_DIR = tmpRoot;

      const probe = defaultRolloutProbe();

      const matchResult = probe('/match');
      expect(matchResult).not.toBeNull();
      expect(typeof matchResult).toBe('number');
      expect(matchResult as number).toBeGreaterThanOrEqual(0);
      expect(matchResult as number).toBeLessThan(5000);

      expect(probe('/other')).toBeNull();

      rmSync(rolloutPath);
      expect(probe('/match')).toBeNull();
    });
  });

  it('(k) STALE notify: new output has since arrived (T+30000) -> must NOT block; falls to screen heuristics (working)', () => {
    const T = FIXED_NOW;
    const outputIdleMs = 60_000;
    const nowMs = T + 90_000; // lastOutputAtMs = nowMs - outputIdleMs = T + 30000
    const adapter = createCodexAdapter(staleProbe);
    const result = adapter.deriveState(
      input({ hookEvents: [notify(T)], idle: outputIdleMs, nowMs, lines: ['just some output'] }),
    );
    expect(result).toEqual({ state: 'working', needs: null });
  });

  it('(k2) STALE notify + prompt screen -> blocked via the GENERIC path (the screen decides, not the old notify)', () => {
    const T = FIXED_NOW;
    const outputIdleMs = 60_000;
    const nowMs = T + 90_000;
    const adapter = createCodexAdapter(staleProbe);
    const result = adapter.deriveState(
      input({ hookEvents: [notify(T)], idle: outputIdleMs, nowMs, lines: ['Proceed? [y/N]'] }),
    );
    expect(result).toEqual({ state: 'blocked', needs: 'confirm [y/N]' });
  });

  it('(k3) trailing paint (output at T+1500, inside NOTIFY_TRAILING_MS) does not invalidate the notify -> blocked, same as (a)', () => {
    const T = FIXED_NOW;
    const outputIdleMs = 60_000;
    const nowMs = T + 1500 + outputIdleMs; // lastOutputAtMs = T + 1500
    const adapter = createCodexAdapter(staleProbe);
    const result = adapter.deriveState(
      input({ hookEvents: [notify(T)], idle: outputIdleMs, nowMs }),
    );
    expect(result).toEqual({ state: 'blocked', needs: 'awaiting input' });
  });

  it('(k4) unparseable `at` on every notify -> treated as no active notify -> degraded path decides via the screen', () => {
    const badNotify: HookEvent = { event: 'notify', at: 'not-a-timestamp', payload: {} };
    const adapter = createCodexAdapter(staleProbe);
    const result = adapter.deriveState(
      input({ hookEvents: [badNotify], lines: ['Proceed? [y/N]'], idle: 5000 }),
    );
    expect(result).toEqual({ state: 'blocked', needs: 'confirm [y/N]' });
  });

  it('is pure: same input twice yields identical results, no module state', () => {
    const idle = 60_000;
    const lastOutputAtMs = FIXED_NOW - idle;
    const adapter = createCodexAdapter(staleProbe);
    const x = input({ hookEvents: [notify(lastOutputAtMs)], idle });
    const first = adapter.deriveState(x);
    const second = adapter.deriveState(x);
    expect(first).toEqual(second);
    expect(adapter.deriveState(x)).toEqual(first);
  });

  it('registers under "codex" in the adapter registry', () => {
    expect(resolveAdapter('codex').id).toBe('codex');
  });
});
