import { collectUsage } from '../usage/collect.js';

// --- Singleton lifecycle ---

let timer: ReturnType<typeof setInterval> | null = null;
let activeRun: Promise<unknown> | null = null;

export interface UsageCollectorOptions {
  intervalMs?: number;
  collect?: () => Promise<unknown>;
}

let savedOptions: UsageCollectorOptions | null = null;

export function startUsageCollector(opts: UsageCollectorOptions = {}): void {
  if (timer) return;
  savedOptions = opts;
  const intervalMs = opts.intervalMs ?? 600_000;
  // Run once immediately, then on interval
  run();
  timer = setInterval(() => {
    run();
  }, intervalMs);
}

export async function stopUsageCollector(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  // Await in-flight run to prevent overlap
  if (activeRun) {
    await activeRun;
    activeRun = null;
  }
  savedOptions = null;
}

function run(): void {
  if (activeRun) return;
  const collectFn = savedOptions?.collect ?? collectUsage;
  activeRun = collectFn()
    .catch((err) => {
      console.error('[usage-collector] collection failed:', err);
    })
    .finally(() => {
      activeRun = null;
    });
}
