/**
 * Periodic agent-session maintenance: stale sweep + optional auto-summarize.
 * Replaces autodiscovery's timer after server/tmux tracking was removed.
 */

export type SummarizeAfterScan = (opts: {
  limit: number;
  signal?: AbortSignal;
}) => Promise<Array<{ kind: string }>>;

export interface MaintenanceLoopOptions {
  projectsDir: string;
  intervalMs?: number;
  /** Invoked when the stale sweep changed any DB row (drives the WS broadcast). */
  onAgentSessionsChanged?: () => void;
  /**
   * Post-scan auto-summary pass. Injectable so tests can drive the trigger
   * without spawning an LLM; when omitted, the real config-gated pass is used.
   */
  summarizeAfterScan?: SummarizeAfterScan;
}

export interface MaintenanceTickOptions {
  projectsDir: string;
  summarizeAfterScan?: SummarizeAfterScan;
  onAgentSessionsChanged?: () => void;
}

let timer: ReturnType<typeof setInterval> | null = null;
let savedOptions: MaintenanceLoopOptions | null = null;
let activeTick: Promise<void> | null = null;

/** Max time stopMaintenanceLoop waits for an aborted summarize pass to unwind. */
const SHUTDOWN_DRAIN_MS = 5_000;

export function startMaintenanceLoop(opts: MaintenanceLoopOptions): void {
  if (timer) return;
  savedOptions = opts;
  const interval = opts.intervalMs ?? 45_000;
  void runMaintenanceTick(opts);
  timer = setInterval(() => {
    if (savedOptions) void runMaintenanceTick(savedOptions);
  }, interval);
}

export async function stopMaintenanceLoop(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (activeTick) {
    await activeTick;
    activeTick = null;
  }
  if (activeSummarize) {
    summarizeAbort?.abort();
    const pass = activeSummarize;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((r) => {
      drainTimer = setTimeout(r, SHUTDOWN_DRAIN_MS);
    });
    await Promise.race([pass, deadline]);
    if (drainTimer) clearTimeout(drainTimer);
    activeSummarize = null;
  }
  savedOptions = null;
}

export async function runMaintenanceTick(opts: MaintenanceTickOptions): Promise<void> {
  if (activeTick) return;
  activeTick = runMaintenanceTickInner(opts)
    .catch((err) => {
      console.error('[maintenance-loop] tick failed:', err);
    })
    .finally(() => {
      activeTick = null;
    });
  await activeTick;
}

async function runMaintenanceTickInner(opts: MaintenanceTickOptions): Promise<void> {
  const { isSessionDbInitialized } = await import('./session-db.js');
  if (!isSessionDbInitialized()) return;

  try {
    const { runSessionMaintenance } = await import('./agent-sessions.js');
    const result = await runSessionMaintenance(opts.projectsDir);
    if (result.reconciled > 0 || result.swept.length > 0) opts.onAgentSessionsChanged?.();
  } catch (err) {
    console.error('[maintenance-loop] session maintenance failed:', err);
  }

  void runSummarizePass(opts.summarizeAfterScan, opts.onAgentSessionsChanged).catch((err) => {
    console.error('[maintenance-loop] auto-summary failed:', err);
  });
}

let activeSummarize: Promise<void> | null = null;
let summarizeAbort: AbortController | null = null;
let summarizeInFlight = false;

/** Default batch size per tick — small, because each item is a paid LLM call. */
const AUTO_SUMMARIZE_LIMIT = 2;

export async function runSummarizePass(
  injected: SummarizeAfterScan | undefined,
  onAgentSessionsChanged: (() => void) | undefined,
): Promise<void> {
  if (summarizeInFlight) return;
  summarizeInFlight = true;

  const controller = new AbortController();
  summarizeAbort = controller;
  const pass = runSummarizeInner(injected, onAgentSessionsChanged, controller.signal);
  activeSummarize = pass.then(
    () => {},
    () => {},
  );
  try {
    await pass;
  } finally {
    summarizeInFlight = false;
    if (summarizeAbort === controller) summarizeAbort = null;
    activeSummarize = null;
  }
}

async function runSummarizeInner(
  injected: SummarizeAfterScan | undefined,
  onAgentSessionsChanged: (() => void) | undefined,
  signal?: AbortSignal,
): Promise<void> {
  let run = injected;
  if (!run) {
    const { readConfig } = await import('../utils/config.js');
    const config = await readConfig();
    if (config.session.autoSummarize !== 'on') return;
    const { summarizeMissing } = await import('../sessions/summarizer.js');
    const { resolveBackend } = await import('../sessions/summarize-backends.js');
    const { backend } = resolveBackend(undefined, config);
    run = ({ limit, signal: sig }) => summarizeMissing({ backend, limit, deps: { signal: sig } });
  }

  const results = await run({ limit: AUTO_SUMMARIZE_LIMIT, signal });
  if (results.some((r) => r.kind === 'ok')) onAgentSessionsChanged?.();
}

/** Test helper — clear the in-flight latch between cases. */
export function _resetSummarizeInFlightForTests(): void {
  summarizeInFlight = false;
}
