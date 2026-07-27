import { describe, it, expect, vi } from 'vitest';

// runClaudeAttach spawns the binary resolveClaudeAttachBinary() verified (a
// PATH shim can shadow the real claude — see capability.ts). Pin it here so
// these units are hermetic and assert the resolved-binary spawn contract.
vi.mock('../capability.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveClaudeAttachBinary: vi.fn(async () => '/resolved/claude'),
}));

import {
  buildClaudeAttachArgv,
  buildClaudeAgentViewArgv,
  runClaudeAttach,
  runClaudeAgentView,
} from '../attach.js';

function fakeChild(exitCode = 0) {
  const h: Record<string, (a?: unknown) => void> = {};
  queueMicrotask(() => h['exit']?.(exitCode));
  return { on: (evt: string, cb: (a?: unknown) => void) => { h[evt] = cb; } };
}

function fakeErrorChild(err: Error) {
  const h: Record<string, (a?: unknown) => void> = {};
  queueMicrotask(() => h['error']?.(err));
  return { on: (evt: string, cb: (a?: unknown) => void) => { h[evt] = cb; } };
}

function fakeChildExitWithNoArg() {
  const h: Record<string, (a?: unknown) => void> = {};
  queueMicrotask(() => h['exit']?.());
  return { on: (evt: string, cb: (a?: unknown) => void) => { h[evt] = cb; } };
}

describe('claude direct attach (hidden `claude attach <id>`)', () => {
  // REGRESSION CONTEXT (0.78.0, user-reported): `attach` is a HIDDEN commander
  // command — it exists on 2.1.218+ but NOT on older claudes, where the word
  // falls through to claude's [prompt] argument and launches a NEW session
  // prompted "attach <short>". That is why this argv may only be spawned
  // behind `checkClaudeAttachCommand()` (see capability.test.ts, and the
  // Cockpit tests asserting the picker fallback when the probe is false).
  it('builds `attach <short>` argv', () => {
    expect(buildClaudeAttachArgv('ab12cd34')).toEqual(['attach', 'ab12cd34']);
  });

  it('spawns the RESOLVED binary (never bare `claude` — a shim could shadow it) with inherited stdio', async () => {
    const spawnFn = vi.fn(() => fakeChild(0));
    await runClaudeAttach('ab12cd34', spawnFn as never);
    expect(spawnFn).toHaveBeenCalledWith('/resolved/claude', ['attach', 'ab12cd34'], { stdio: 'inherit' });
  });

  it('resolves { code } propagating a non-zero exit (e.g. "No job matching")', async () => {
    const spawnFn = vi.fn(() => fakeChild(1));
    expect(await runClaudeAttach('id', spawnFn as never)).toEqual({ code: 1 });
  });

  it('coerces an undefined exit code to null', async () => {
    const spawnFn = vi.fn(() => fakeChildExitWithNoArg());
    expect(await runClaudeAttach('id', spawnFn as never)).toEqual({ code: null });
  });

  it('resolves { code: null, error } on a spawn error, and never rejects', async () => {
    const err = new Error('spawn claude ENOENT');
    const spawnFn = vi.fn(() => fakeErrorChild(err));
    const result = await runClaudeAttach('id', spawnFn as never);
    expect(result.code).toBe(null);
    expect(result.error).toBe(err);
  });
});

describe('claude Agent View fallback (`claude agents`)', () => {
  it('opens the picker with no positional session id (claude agents takes none)', () => {
    expect(buildClaudeAgentViewArgv()).toEqual(['agents']);
  });

  it('spawns claude agents with inherited stdio', async () => {
    const spawnFn = vi.fn(() => fakeChild(0));
    await runClaudeAgentView(spawnFn as never);
    expect(spawnFn).toHaveBeenCalledWith('claude', ['agents'], { stdio: 'inherit' });
  });

  it('resolves { code } on a clean exit', async () => {
    const spawnFn = vi.fn(() => fakeChild(0));
    expect(await runClaudeAgentView(spawnFn as never)).toEqual({ code: 0 });
  });

  it('never rejects on spawn error', async () => {
    const err = new Error('spawn claude ENOENT');
    const spawnFn = vi.fn(() => fakeErrorChild(err));
    const result = await runClaudeAgentView(spawnFn as never);
    expect(result.code).toBe(null);
    expect(result.error).toBe(err);
  });
});
