import { describe, it, expect, vi } from 'vitest';
import { buildSyntaurAttachArgv, runSyntaurdAttach } from '../attach.js';
import { cliEntryPath } from '../../../daemon/paths.js';

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

describe('syntaurd attach', () => {
  it('builds attach argv with an injectable entry path', () => {
    expect(buildSyntaurAttachArgv('sd12ab34', '/opt/syntaur/dist/index.js')).toEqual([
      '/opt/syntaur/dist/index.js', 'attach', 'sd12ab34',
    ]);
  });

  it('defaults the entry path to cliEntryPath()', () => {
    expect(buildSyntaurAttachArgv('sd12ab34')).toEqual([cliEntryPath(), 'attach', 'sd12ab34']);
  });

  it('spawns process.execPath with the CLI-entry attach argv and inherited stdio', async () => {
    const spawnFn = vi.fn(() => fakeChild(0));
    await runSyntaurdAttach('sd12ab34', spawnFn as never);
    expect(spawnFn).toHaveBeenCalledWith(
      process.execPath,
      [cliEntryPath(), 'attach', 'sd12ab34'],
      { stdio: 'inherit' },
    );
  });

  it('resolves { code } on a clean exit', async () => {
    const spawnFn = vi.fn(() => fakeChild(0));
    expect(await runSyntaurdAttach('id', spawnFn as never)).toEqual({ code: 0 });
  });

  it('resolves { code } propagating a non-zero exit code', async () => {
    const spawnFn = vi.fn(() => fakeChild(1));
    expect(await runSyntaurdAttach('id', spawnFn as never)).toEqual({ code: 1 });
  });

  it('coerces an undefined exit code to null', async () => {
    const spawnFn = vi.fn(() => fakeChildExitWithNoArg());
    expect(await runSyntaurdAttach('id', spawnFn as never)).toEqual({ code: null });
  });

  it('resolves { code: null, error } on a spawn error, and never rejects', async () => {
    const err = new Error('spawn node ENOENT');
    const spawnFn = vi.fn(() => fakeErrorChild(err));
    const result = await runSyntaurdAttach('id', spawnFn as never);
    expect(result.code).toBe(null);
    expect(result.error).toBe(err);
  });
});
