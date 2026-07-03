import { describe, it, expect, vi } from 'vitest';
import { buildTmuxAttachArgv, runTmuxAttach } from '../attach.js';

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

/** Emits 'exit' with NO argument at all (distinct from `fakeChild(undefined)`,
 * which resolves to the default parameter value 0). */
function fakeChildExitWithNoArg() {
  const h: Record<string, (a?: unknown) => void> = {};
  queueMicrotask(() => h['exit']?.());
  return { on: (evt: string, cb: (a?: unknown) => void) => { h[evt] = cb; } };
}

describe('tmux attach', () => {
  it('builds attach argv', () => {
    expect(buildTmuxAttachArgv('w')).toEqual(['attach-session', '-t', 'w']);
  });
  it('runTmuxAttach spawns inherit and resolves on child exit', async () => {
    const spawnFn = vi.fn(() => fakeChild(0));
    await runTmuxAttach('w', spawnFn as never);
    expect(spawnFn).toHaveBeenCalledWith('tmux', ['attach-session', '-t', 'w'], { stdio: 'inherit' });
  });

  it('resolves { code } propagating the exit code on a clean exit', async () => {
    const spawnFn = vi.fn(() => fakeChild(0));
    const result = await runTmuxAttach('w', spawnFn as never);
    expect(result).toEqual({ code: 0 });
  });

  it('resolves { code } propagating a non-zero exit code', async () => {
    const spawnFn = vi.fn(() => fakeChild(1));
    const result = await runTmuxAttach('w', spawnFn as never);
    expect(result).toEqual({ code: 1 });
  });

  it('coerces an undefined exit code to null', async () => {
    const spawnFn = vi.fn(() => fakeChildExitWithNoArg());
    const result = await runTmuxAttach('w', spawnFn as never);
    expect(result).toEqual({ code: null });
  });

  it('resolves { code: null, error } on a spawn error, and never rejects', async () => {
    const err = new Error('spawn tmux ENOENT');
    const spawnFn = vi.fn(() => fakeErrorChild(err));
    const result = await runTmuxAttach('w', spawnFn as never);
    expect(result.code).toBe(null);
    expect(result.error).toBe(err);
  });
});
