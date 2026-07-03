import { describe, it, expect, vi } from 'vitest';
import { buildClaudeAttachArgv, runClaudeAttach } from '../attach.js';

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

describe('claude attach', () => {
  it('builds attach argv', () => {
    expect(buildClaudeAttachArgv('ab12cd34')).toEqual(['attach', 'ab12cd34']);
  });

  it('spawns claude attach <id> with inherited stdio', async () => {
    const spawnFn = vi.fn(() => fakeChild(0));
    await runClaudeAttach('ab12cd34', spawnFn as never);
    expect(spawnFn).toHaveBeenCalledWith('claude', ['attach', 'ab12cd34'], { stdio: 'inherit' });
  });

  it('resolves { code } on a clean exit', async () => {
    const spawnFn = vi.fn(() => fakeChild(0));
    expect(await runClaudeAttach('id', spawnFn as never)).toEqual({ code: 0 });
  });

  it('resolves { code } propagating a non-zero exit code', async () => {
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
