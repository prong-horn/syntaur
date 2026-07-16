import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkSyntaurdAvailable, resetSyntaurdAvailableCache } from '../capability.js';

afterEach(() => resetSyntaurdAvailableCache());

describe('checkSyntaurdAvailable', () => {
  it('resolves true when the probe succeeds', async () => {
    expect(await checkSyntaurdAvailable(async () => 'ok')).toBe(true);
  });

  it('resolves false (never rejects) when the probe fails', async () => {
    expect(await checkSyntaurdAvailable(async () => { throw new Error('broken prebuild'); })).toBe(false);
  });

  it('memoizes across calls — the probe runs at most once', async () => {
    const probe = vi.fn(async () => 'ok');
    await checkSyntaurdAvailable(probe);
    await checkSyntaurdAvailable(probe);
    await checkSyntaurdAvailable(probe);
    expect(probe).toHaveBeenCalledOnce();
  });

  it('resetSyntaurdAvailableCache forces a fresh probe', async () => {
    const probe = vi.fn(async () => 'ok');
    await checkSyntaurdAvailable(probe);
    resetSyntaurdAvailableCache();
    await checkSyntaurdAvailable(probe);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
