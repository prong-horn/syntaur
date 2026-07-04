import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkClaudeBgAvailable, resetClaudeBgAvailableCache } from '../capability.js';

afterEach(() => resetClaudeBgAvailableCache());

describe('checkClaudeBgAvailable', () => {
  it('resolves true when the probe succeeds', async () => {
    expect(await checkClaudeBgAvailable(async () => 'ok')).toBe(true);
  });

  it('resolves false (never rejects) when the probe fails', async () => {
    expect(await checkClaudeBgAvailable(async () => { throw new Error('ENOENT'); })).toBe(false);
  });

  it('memoizes across calls — the probe runs at most once', async () => {
    const probe = vi.fn(async () => 'ok');
    await checkClaudeBgAvailable(probe);
    await checkClaudeBgAvailable(probe);
    await checkClaudeBgAvailable(probe);
    expect(probe).toHaveBeenCalledOnce();
  });

  it('resetClaudeBgAvailableCache forces a fresh probe', async () => {
    const probe = vi.fn(async () => 'ok');
    await checkClaudeBgAvailable(probe);
    resetClaudeBgAvailableCache();
    await checkClaudeBgAvailable(probe);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
