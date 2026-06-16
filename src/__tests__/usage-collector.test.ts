import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startUsageCollector, stopUsageCollector } from '../dashboard/usage-collector.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await stopUsageCollector();
  vi.useRealTimers();
});

describe('startUsageCollector', () => {
  it('invokes collect immediately on start', async () => {
    const stub = vi.fn().mockResolvedValue(undefined);
    startUsageCollector({ collect: stub, intervalMs: 600_000 });
    // Flush microtasks so the immediately-scheduled async call can start
    await Promise.resolve();
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it('invokes collect again after the interval elapses', async () => {
    const stub = vi.fn().mockResolvedValue(undefined);
    startUsageCollector({ collect: stub, intervalMs: 600_000 });
    // Flush the immediate invocation
    await vi.advanceTimersByTimeAsync(0);
    expect(stub).toHaveBeenCalledTimes(1);

    // Advance one full interval
    await vi.advanceTimersByTimeAsync(600_000);
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it('does not start a second concurrent run when previous is in-flight (overlap guard)', async () => {
    let resolvePending!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolvePending = resolve;
    });
    const stub = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(undefined);

    startUsageCollector({ collect: stub, intervalMs: 600_000 });
    // The first call is started immediately and is in-flight (pending)
    await Promise.resolve();
    expect(stub).toHaveBeenCalledTimes(1);

    // Advance the interval — the overlap guard should skip a second run
    await vi.advanceTimersByTimeAsync(600_000);
    // Still only 1 call because the first is still pending
    expect(stub).toHaveBeenCalledTimes(1);

    // Now let the first run finish
    resolvePending();
    await vi.advanceTimersByTimeAsync(0);

    // Advance another interval — now a new run can proceed
    await vi.advanceTimersByTimeAsync(600_000);
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it('does not run again after stopUsageCollector is called', async () => {
    const stub = vi.fn().mockResolvedValue(undefined);
    startUsageCollector({ collect: stub, intervalMs: 600_000 });
    // Flush immediate invocation
    await vi.advanceTimersByTimeAsync(0);
    expect(stub).toHaveBeenCalledTimes(1);

    await stopUsageCollector();

    // Advance further — should not trigger another run
    await vi.advanceTimersByTimeAsync(600_000);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it('awaits an in-flight run when stopping', async () => {
    const order: string[] = [];
    let resolvePending!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolvePending = resolve;
    });
    const stub = vi.fn().mockImplementationOnce(async () => {
      await pending;
      order.push('run-done');
    });

    startUsageCollector({ collect: stub, intervalMs: 600_000 });
    // The first run is in-flight
    await Promise.resolve();

    // Begin stopping — it should await the in-flight run
    const stopPromise = stopUsageCollector().then(() => {
      order.push('stop-done');
    });

    // Resolve the in-flight run
    resolvePending();
    await stopPromise;

    expect(order).toEqual(['run-done', 'stop-done']);
  });

  it('is idempotent — calling start twice does not double-schedule', async () => {
    const stub = vi.fn().mockResolvedValue(undefined);
    startUsageCollector({ collect: stub, intervalMs: 600_000 });
    startUsageCollector({ collect: stub, intervalMs: 600_000 }); // second call is a no-op

    await vi.advanceTimersByTimeAsync(0);
    expect(stub).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(600_000);
    // Only one interval fires, not two
    expect(stub).toHaveBeenCalledTimes(2);
  });
});
