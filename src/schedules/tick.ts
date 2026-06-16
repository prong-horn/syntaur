/**
 * The tick — the ONE scheduler authority (Task 10). It reads all jobs from
 * disk, evaluates every trigger family against PERSISTED state, fires those that
 * are due (claim → resolve-at-fire-time → launch → launch-ack), and reaps stale
 * attempts. It is MECHANISM, not policy: it detects + records stuck/failed and
 * stops — no remediation (that lives behind the control verbs). The dashboard
 * watcher is a pure accelerator that calls `runTick`; it is never the source of
 * truth. Every effecting dependency is injectable so the whole tick is
 * unit-testable with an injected clock / launcher / ack / assignment reader.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readConfig } from '../utils/config.js';
import { assignmentsDir, defaultProjectDir } from '../utils/paths.js';
import { resolveAssignmentById } from '../utils/assignment-resolver.js';
import { parseAssignmentFrontmatter } from '../lifecycle/frontmatter.js';
import { resolveLaunchPlan } from '../launch/plan.js';
import { executeLaunchPlan, type LaunchHandle } from '../launch/execute.js';
import type { LaunchPlan } from '../launch/plan.js';
import type { AssignmentFrontmatter } from '../lifecycle/types.js';
import { appendEvent } from './event-log.js';
import { listJobs } from './store.js';
import { evaluateTrigger, isRecurring } from './triggers.js';
import { canFire, isKillSwitchEngaged } from './unattended.js';
import { awaitLaunchAck, type AckResult } from './launch-ack.js';
import {
  claimJob,
  markLaunching,
  markRunning,
  markLaunchFailed,
  markRanAndReArm,
  reapStale,
} from './attempt.js';
import { watchedAssignmentId, type ScheduledJob } from './types.js';

export interface TickDeps {
  now?: () => Date;
  /** Parsed frontmatter of a watched assignment (state triggers). */
  readAssignment?: (assignmentId: string) => Promise<AssignmentFrontmatter | null>;
  /** Resolve a launch plan at FIRE time (recomputes cwd/worktree). */
  resolvePlan?: (job: ScheduledJob) => Promise<LaunchPlan>;
  /** Spawn the terminal. Defaults to `executeLaunchPlan`. */
  launch?: (plan: LaunchPlan) => Promise<LaunchHandle>;
  /** Poll for launch-ack. Defaults to `awaitLaunchAck`. */
  ack?: (handle: LaunchHandle, ackTimeoutMs: number) => Promise<AckResult>;
  isSessionLive?: (sessionId: string | null, pid: number | null) => boolean;
  killSwitch?: () => boolean;
  log?: (message: string) => void;
  /** When false, skip the reap pass (the `fire-due` accelerator path). Default true. */
  reap?: boolean;
}

export interface TickResult {
  evaluated: number;
  fired: string[];
  failed: string[];
  skipped: number;
  reaped: string[];
  stuck: string[];
}

async function defaultReadAssignment(assignmentId: string): Promise<AssignmentFrontmatter | null> {
  const config = await readConfig();
  const projectsDir = config.defaultProjectDir || defaultProjectDir();
  const resolved = await resolveAssignmentById(projectsDir, assignmentsDir(), assignmentId);
  if (!resolved) return null;
  try {
    const content = await readFile(resolve(resolved.assignmentDir, 'assignment.md'), 'utf-8');
    return parseAssignmentFrontmatter(content);
  } catch {
    return null;
  }
}

async function defaultResolvePlan(job: ScheduledJob): Promise<LaunchPlan> {
  const config = await readConfig();
  const projectsDir = config.defaultProjectDir || defaultProjectDir();
  return resolveLaunchPlan({
    kind: 'assignment',
    id: job.assignmentId,
    config,
    projectsDir,
    assignmentsDir: assignmentsDir(),
    terminalOverride: job.terminalPreference ?? undefined,
    agentId: job.agentId,
    promptOverride: job.promptTemplate ?? undefined,
  });
}

/** Run one tick across all jobs. Idempotent and safe to run concurrently with
 *  other actors (claim-lease + dedupe make double-fire impossible). */
export async function runTick(deps: TickDeps = {}): Promise<TickResult> {
  const now = deps.now ?? (() => new Date());
  const attemptDeps = { now, isSessionLive: deps.isSessionLive };
  const result: TickResult = { evaluated: 0, fired: [], failed: [], skipped: 0, reaped: [], stuck: [] };

  // Reap first (crash recovery / stuck detection) — always runs, even under the
  // kill switch (reaping is mechanism, not new firing). The `fire-due`
  // accelerator path skips it (reap: false).
  if (deps.reap !== false) {
    const reap = await reapStale(await listJobs(), attemptDeps);
    result.reaped = reap.reaped;
    result.stuck = reap.stuck;
  }

  // Re-list: reaping mutated some files.
  const jobs = await listJobs();
  for (const job of jobs) {
    if (job.attempt.state !== 'eligible') continue;
    result.evaluated++;

    let assignment: AssignmentFrontmatter | null = null;
    if (job.trigger.kind === 'when-status' || job.trigger.kind === 'when-plan-lands') {
      assignment = await (deps.readAssignment ?? defaultReadAssignment)(watchedAssignmentId(job));
    }

    const evaluation = evaluateTrigger(job, { now: now(), assignment });
    if (!evaluation.due || !evaluation.dedupeKey) {
      result.skipped++;
      continue;
    }

    const gate = canFire(job, { now, killSwitch: deps.killSwitch ?? isKillSwitchEngaged });
    if (!gate.allowed) {
      deps.log?.(`schedule ${job.id} gated: ${gate.reason}`);
      result.skipped++;
      continue; // don't consume the edge — a cooldown/limit denial retries next tick
    }

    const claim = await claimJob(
      job,
      { dedupeKey: evaluation.dedupeKey, nextCursor: evaluation.nextCursor },
      attemptDeps,
    );
    if (!claim.claimed) {
      result.skipped++;
      continue;
    }
    let current = claim.job;

    try {
      const plan = await (deps.resolvePlan ?? defaultResolvePlan)(current);
      if (current.unattended && plan.terminal === 'warp') {
        current = await markLaunchFailed(current, 'warp cannot auto-start an unattended job');
        result.failed.push(current.id);
        continue;
      }
      const handle = await (deps.launch ?? executeLaunchPlan)(plan);
      current = await markLaunching(current, handle.pid ?? null, attemptDeps);
      const ackFn = deps.ack ?? ((h, t) => awaitLaunchAck(h, t));
      const ack = await ackFn(handle, current.timing.ackTimeoutMs);
      if (ack.acked) {
        // Recurring (cron): record the run AND re-arm in one atomic write
        // (crash-safe). One-shot: stay `running` (a session-end observer / reaper
        // takes it terminal later).
        current = isRecurring(current.trigger)
          ? await markRanAndReArm(current, ack.sessionId ?? null, attemptDeps)
          : await markRunning(current, ack.sessionId ?? null, attemptDeps);
        result.fired.push(current.id);
      } else {
        current = await markLaunchFailed(current, 'launch-ack timeout');
        result.failed.push(current.id);
      }
    } catch (err) {
      current = await markLaunchFailed(current, err instanceof Error ? err.message : String(err));
      await appendEvent(current.id, 'failed', { error: err instanceof Error ? err.message : String(err) });
      result.failed.push(current.id);
    }
  }

  return result;
}
