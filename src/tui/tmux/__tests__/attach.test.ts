import { describe, it, expect, vi } from 'vitest';
import { buildTmuxAttachArgv, runTmuxAttach } from '../attach.js';

function fakeChild(exitCode = 0) {
  const h: Record<string, (a?: unknown) => void> = {};
  queueMicrotask(() => h['exit']?.(exitCode));
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
});
