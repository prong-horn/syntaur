import { describe, it, expect } from 'vitest';
import { isSameProcess } from '../liveness.js';

describe('isSameProcess', () => {
  it('returns false when the pid is not alive', () => {
    expect(isSameProcess(1234, 'START', { isPidAlive: () => false })).toBe(false);
  });

  it('trusts kill -0 alone when no start-time baseline was recorded', () => {
    expect(isSameProcess(1234, null, { isPidAlive: () => true })).toBe(true);
  });

  it('returns true when alive and the start-time matches the baseline', () => {
    expect(
      isSameProcess(1234, 'START', { isPidAlive: () => true, pidStartedAt: () => 'START' }),
    ).toBe(true);
  });

  it('returns false when alive but the start-time no longer matches (recycled pid)', () => {
    expect(
      isSameProcess(1234, 'START', { isPidAlive: () => true, pidStartedAt: () => 'DIFFERENT' }),
    ).toBe(false);
  });

  it('fails CLOSED when a baseline exists but the current start-time is unknown', () => {
    // A live pid whose `ps` lookup transiently returns null must NOT be treated
    // as the same process — identity cannot be confirmed.
    expect(
      isSameProcess(1234, 'START', { isPidAlive: () => true, pidStartedAt: () => null }),
    ).toBe(false);
  });
});
