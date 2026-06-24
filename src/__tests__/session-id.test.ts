import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveOwnSessionId,
  writeRuntimeMarker,
  readRuntimeMarker,
  isSafeSessionId,
  SESSION_ID_ENV_VARS,
  mayMutateWithProvenance,
  assertMayMutate,
  type ResolverDeps,
} from '../utils/session-id.js';

// Deps that make layers 4/5 a no-op unless a test overrides them, so each test
// exercises exactly the layer it targets.
function inertDeps(overrides: ResolverDeps = {}): ResolverDeps {
  return {
    env: {},
    startPid: 5000,
    readPpid: () => null,
    pidStartedAt: () => null,
    claudeSessionsDir: '/nonexistent/claude',
    runtimeSessionsDir: '/nonexistent/runtime',
    statMtimeMs: () => null,
    ...overrides,
  };
}

describe('resolveOwnSessionId', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'syntaur-resolver-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('layer 1 — explicit override', () => {
    it('wins over env, markers, and hint', async () => {
      const id = await resolveOwnSessionId(
        { sessionId: 'explicit', legacyHint: 'hint' },
        inertDeps({ env: { CLAUDE_CODE_SESSION_ID: 'env-id' } }),
      );
      expect(id?.id).toBe('explicit');
      expect(id?.provenance).toBe('EXPLICIT');
    });
    it('ignores an empty explicit id and falls through', async () => {
      const id = await resolveOwnSessionId(
        { sessionId: '', legacyHint: 'hint' },
        inertDeps(),
      );
      expect(id?.id).toBe('hint');
      expect(id?.provenance).toBe('WEAK');
    });
  });

  describe('layer 2 — env var precedence', () => {
    it('prefers CLAUDE_CODE_SESSION_ID over the peers', async () => {
      const id = await resolveOwnSessionId(
        {},
        inertDeps({
          env: {
            CLAUDE_CODE_SESSION_ID: 'claude',
            OPENCODE_SESSION_ID: 'opencode',
            PI_SESSION_ID: 'pi',
          },
        }),
      );
      expect(id?.id).toBe('claude');
      expect(id?.provenance).toBe('STRONG');
    });
    it('falls to OPENCODE then PI in order', async () => {
      expect(
        await resolveOwnSessionId({}, inertDeps({ env: { OPENCODE_SESSION_ID: 'opencode', PI_SESSION_ID: 'pi' } })),
      ).toMatchObject({ id: 'opencode', provenance: 'STRONG' });
      expect(await resolveOwnSessionId({}, inertDeps({ env: { PI_SESSION_ID: 'pi' } }))).toMatchObject({ id: 'pi', provenance: 'STRONG' });
    });
    it('treats empty env values as misses', async () => {
      const id = await resolveOwnSessionId(
        { legacyHint: 'hint' },
        inertDeps({ env: { CLAUDE_CODE_SESSION_ID: '', OPENCODE_SESSION_ID: '' } }),
      );
      expect(id?.id).toBe('hint');
      expect(id?.provenance).toBe('WEAK');
    });
    it('exposes the env var list in precedence order', () => {
      expect([...SESSION_ID_ENV_VARS]).toEqual([
        'CLAUDE_CODE_SESSION_ID',
        'OPENCODE_SESSION_ID',
        'PI_SESSION_ID',
      ]);
    });
  });

  describe('layer 4 — ancestor-pid marker walk', () => {
    it('returns the id from a marker at the start pid', async () => {
      writeRuntimeMarker(4242, { sessionId: 'marker-id' }, dir);
      const id = await resolveOwnSessionId({}, inertDeps({ startPid: 4242, runtimeSessionsDir: dir }));
      expect(id?.id).toBe('marker-id');
      expect(id?.provenance).toBe('STRONG');
    });

    it('walks up the parent chain to find a marker on an ancestor', async () => {
      writeRuntimeMarker(99, { sessionId: 'grandparent' }, dir);
      const chain: Record<number, number> = { 10: 20, 20: 99 };
      const id = await resolveOwnSessionId(
        {},
        inertDeps({ startPid: 10, runtimeSessionsDir: dir, readPpid: (p) => chain[p] ?? null }),
      );
      expect(id?.id).toBe('grandparent');
      expect(id?.provenance).toBe('STRONG');
    });

    it('skips a marker whose procStart no longer matches (pid reuse)', async () => {
      writeRuntimeMarker(4242, { sessionId: 'stale', procStart: 'OLD' }, dir);
      const id = await resolveOwnSessionId(
        { legacyHint: 'hint' },
        inertDeps({ startPid: 4242, runtimeSessionsDir: dir, pidStartedAt: () => 'NEW' }),
      );
      expect(id?.id).toBe('hint'); // stale marker skipped, fell through to layer 6
      expect(id?.provenance).toBe('WEAK');
    });

    it('accepts a marker whose procStart still matches', async () => {
      writeRuntimeMarker(4242, { sessionId: 'fresh', procStart: 'SAME' }, dir);
      const id = await resolveOwnSessionId(
        {},
        inertDeps({ startPid: 4242, runtimeSessionsDir: dir, pidStartedAt: () => 'SAME' }),
      );
      expect(id?.id).toBe('fresh');
      expect(id?.provenance).toBe('STRONG');
    });

    it('fails CLOSED: skips a procStart marker when the live start time is unreadable', async () => {
      writeRuntimeMarker(4242, { sessionId: 'unprovable', procStart: 'SOME' }, dir);
      const id = await resolveOwnSessionId(
        { legacyHint: 'hint' },
        inertDeps({ startPid: 4242, runtimeSessionsDir: dir, pidStartedAt: () => null }),
      );
      expect(id?.id).toBe('hint'); // cannot prove the pid wasn't recycled → skip the marker
      expect(id?.provenance).toBe('WEAK');
    });

    it('reads the marker before probing ps (no ps call on marker-less levels)', async () => {
      const pidStartedAt = vi.fn(() => 'whatever');
      // Marker WITHOUT procStart at the start pid → resolves without ever calling pidStartedAt.
      writeRuntimeMarker(4242, { sessionId: 'no-procstart' }, dir);
      const id = await resolveOwnSessionId(
        {},
        inertDeps({ startPid: 4242, runtimeSessionsDir: dir, pidStartedAt }),
      );
      expect(id?.id).toBe('no-procstart');
      expect(id?.provenance).toBe('STRONG');
      expect(pidStartedAt).not.toHaveBeenCalled();
    });
  });

  describe('layer 6 — legacy hint (and exact-only contract)', () => {
    it('returns the legacy hint when layers 1–5 miss', async () => {
      const id = await resolveOwnSessionId({ legacyHint: 'hint' }, inertDeps());
      expect(id?.id).toBe('hint');
      expect(id?.provenance).toBe('WEAK');
    });
    it('returns undefined when the hint is omitted (exact-only callers)', async () => {
      expect(await resolveOwnSessionId({}, inertDeps())).toBeUndefined();
    });
  });

  describe('session-id validation (path/URL safety)', () => {
    it('rejects an unsafe explicit id and falls through', async () => {
      const result = await resolveOwnSessionId({ sessionId: '../../etc/passwd', legacyHint: 'safe-hint' }, inertDeps());
      expect(result?.id).toBe('safe-hint');
      expect(result?.provenance).toBe('WEAK');
    });
    it('rejects an unsafe env id and falls through', async () => {
      const result = await resolveOwnSessionId({ legacyHint: 'safe-hint' }, inertDeps({ env: { CLAUDE_CODE_SESSION_ID: 'a/b' } }));
      expect(result?.id).toBe('safe-hint');
      expect(result?.provenance).toBe('WEAK');
    });
    it('rejects an unsafe legacy hint (returns undefined)', async () => {
      expect(await resolveOwnSessionId({ legacyHint: '..' }, inertDeps())).toBeUndefined();
    });
    it('rejects an unsafe marker id and falls through', async () => {
      writeRuntimeMarker(4242, { sessionId: '../escape' }, dir);
      const result = await resolveOwnSessionId({ legacyHint: 'safe-hint' }, inertDeps({ startPid: 4242, runtimeSessionsDir: dir }));
      expect(result?.id).toBe('safe-hint');
      expect(result?.provenance).toBe('WEAK');
    });
    it('isSafeSessionId accepts real UUID/ULID ids, rejects separators and dot-paths', () => {
      expect(isSafeSessionId('85544734-b7f3-43ac-9922-139aa62d90b9')).toBe(true);
      expect(isSafeSessionId('019e982a-7411-77f3-a1be-1028a2bb8682')).toBe(true);
      expect(isSafeSessionId('a/b')).toBe(false);
      expect(isSafeSessionId('..')).toBe(false);
      expect(isSafeSessionId('a b')).toBe(false);
      expect(isSafeSessionId('')).toBe(false);
      expect(isSafeSessionId(undefined)).toBe(false);
    });
  });

  describe('layer 5 — cwd transcript scan', () => {
    let prevHome: string | undefined;
    let prevCodexHome: string | undefined;
    let prevCodexSessions: string | undefined;
    let emptyHome: string;

    beforeEach(async () => {
      emptyHome = await mkdtemp(join(tmpdir(), 'syntaur-emptyhome-'));
      prevHome = process.env.HOME;
      prevCodexHome = process.env.CODEX_HOME;
      prevCodexSessions = process.env.CODEX_SESSIONS_DIR;
      process.env.HOME = emptyHome;
      process.env.CODEX_HOME = emptyHome;
      delete process.env.CODEX_SESSIONS_DIR;
    });
    afterEach(async () => {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevCodexHome;
      if (prevCodexSessions === undefined) delete process.env.CODEX_SESSIONS_DIR; else process.env.CODEX_SESSIONS_DIR = prevCodexSessions;
      await rm(emptyHome, { recursive: true, force: true });
    });

    it('returns undefined when no transcript matches the cwd', async () => {
      const id = await resolveOwnSessionId({ cwd: '/no/such/workspace/xyz' }, inertDeps());
      expect(id).toBeUndefined();
    });
  });
});

describe('gate helpers', () => {
  describe('mayMutateWithProvenance', () => {
    it('returns true for STRONG', () => {
      expect(mayMutateWithProvenance('STRONG')).toBe(true);
    });
    it('returns true for EXPLICIT', () => {
      expect(mayMutateWithProvenance('EXPLICIT')).toBe(true);
    });
    it('returns false for WEAK', () => {
      expect(mayMutateWithProvenance('WEAK')).toBe(false);
    });
  });

  describe('assertMayMutate', () => {
    it('passes for STRONG regardless of selector', () => {
      expect(() => assertMayMutate({ id: 'x', provenance: 'STRONG' }, { hasSelector: false })).not.toThrow();
      expect(() => assertMayMutate({ id: 'x', provenance: 'STRONG' }, { hasSelector: true })).not.toThrow();
    });
    it('passes for EXPLICIT regardless of selector', () => {
      expect(() => assertMayMutate({ id: 'x', provenance: 'EXPLICIT' }, { hasSelector: false })).not.toThrow();
      expect(() => assertMayMutate({ id: 'x', provenance: 'EXPLICIT' }, { hasSelector: true })).not.toThrow();
    });
    it('throws for WEAK with no selector', () => {
      expect(() => assertMayMutate({ id: 'x', provenance: 'WEAK' }, { hasSelector: false })).toThrow(/--assignment/);
    });
    it('passes for WEAK with a selector', () => {
      expect(() => assertMayMutate({ id: 'x', provenance: 'WEAK' }, { hasSelector: true })).not.toThrow();
    });
  });
});

describe('readRuntimeMarker / writeRuntimeMarker', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'syntaur-marker-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a marker', () => {
    writeRuntimeMarker(123, { sessionId: 's', agent: 'codex', cwd: '/w', procStart: 'T', writtenAt: 1 }, dir);
    expect(readRuntimeMarker(123, dir)).toMatchObject({ sessionId: 's', agent: 'codex' });
  });
  it('returns null for a missing marker', () => {
    expect(readRuntimeMarker(999, dir)).toBeNull();
  });
  it('returns null for a marker without a sessionId', () => {
    writeRuntimeMarker(124, { sessionId: '' }, dir);
    expect(readRuntimeMarker(124, dir)).toBeNull();
  });
});
