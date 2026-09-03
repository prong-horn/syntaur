/**
 * The tick — the ONE scheduler authority (Task 10). It reads all jobs from
 * disk, evaluates every trigger family against PERSISTED state, fires those that
 * are due (claim → dispatch into the assignment's chat → record the accepted
 * `messageId`), and reaps stale attempts. It is MECHANISM, not policy: it
 * detects + records stuck/failed and stops — no remediation (that lives behind
 * the control verbs). The dashboard watcher is a pure accelerator that calls
 * `runTick`; it is never the source of truth. Every effecting dependency is
 * injectable so the whole tick is unit-testable with an injected clock and a
 * fake dispatcher.
 *
 * Phase 4 (Decision 3): firing is a chat message, not a terminal. Inside the
 * dashboard server the tick holds the broker (`chatBroker`); as the launchd
 * `schedule tick` CLI it talks to the running dashboard (`dashboardPort`). With
 * neither, a due job records an error — there is no terminal fallback.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readConfig } from '../utils/config.js';
import { assignmentsDir, defaultProjectDir } from '../utils/paths.js';
import { resolveAssignmentById } from '../utils/assignment-resolver.js';
import { parseAssignmentFrontmatter } from '../lifecycle/frontmatter.js';
import type { AssignmentFrontmatter } from '../lifecycle/types.js';
import type { ChatBroker } from '../chat/broker.js';
import { appendEvent } from './event-log.js';
import { listJobs } from './store.js';
import { evaluateTrigger, isRecurring } from './triggers.js';
import { canFire, isKillSwitchEngaged } from './unattended.js';
import {
  assertAgentAttached,
  inProcessDispatcher,
  restDispatcher,
  DispatchError,
  type ChatDispatcher,
} from './dispatch.js';
import { messageTurnProbeVia, type ProbeMessageTurn } from './liveness.js';
import {
  claimJob,
  markDispatching,
  markRunning,
  markDispatchFailed,
  markRanAndReArm,
  reapStale,
} from './attempt.js';
import { watchedAssignmentId } from './types.js';

export interface TickDeps {
  now?: () => Date;
  /** Parsed frontmatter of a watched assignment (state triggers). */
  readAssignment?: (assignmentId: string) => Promise<AssignmentFrontmatter | null>;
  /** In-process chat (the tick is running inside the dashboard server). */
  chatBroker?: ChatBroker;
  /** Port of a running dashboard (the launchd `schedule tick` CLI path). */
  dashboardPort?: number | null;
  /** Fully-built dispatcher; overrides `chatBroker`/`dashboardPort` (tests). */
  dispatcher?: ChatDispatcher;
  /** Where a dispatched message's turn stands. Defaults to the dispatcher's probe. */
  probeMessageTurn?: ProbeMessageTurn;
  /** Ceiling on an UNKNOWN message state before a `running` job is terminalized. */
  stateUnknownCeilingMs?: number;
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
  /** One-shot ids reconciled to `completed` (their dispatched turn ended). */
  completed: string[];
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

/**
 * The chat this tick dispatches into, or null when there is none: no broker in
 * process and no dashboard listening. Null is not an error here — it becomes
 * one on each job that is actually due, which is where the user can see it.
 */
function resolveDispatcher(deps: TickDeps): ChatDispatcher | null {
  if (deps.dispatcher) return deps.dispatcher;
  if (deps.chatBroker) {
    return inProcessDispatcher({
      broker: deps.chatBroker,
      resolveAssignment: async (id) => {
        const config = await readConfig();
        const projectsDir = config.defaultProjectDir || defaultProjectDir();
        return resolveAssignmentById(projectsDir, assignmentsDir(), id);
      },
    });
  }
  if (deps.dashboardPort) return restDispatcher({ port: deps.dashboardPort });
  return null;
}

/** Run one tick across all jobs. Idempotent and safe to run concurrently with
 *  other actors (claim-lease + dedupe make double-fire impossible). */
export async function runTick(deps: TickDeps = {}): Promise<TickResult> {
  const now = deps.now ?? (() => new Date());
  const dispatcher = resolveDispatcher(deps);
  const probeMessageTurn =
    deps.probeMessageTurn ?? (dispatcher ? messageTurnProbeVia(dispatcher) : undefined);
  const attemptDeps = {
    now,
    ...(probeMessageTurn ? { probeMessageTurn } : {}),
    ...(deps.stateUnknownCeilingMs === undefined
      ? {}
      : { stateUnknownCeilingMs: deps.stateUnknownCeilingMs }),
  };
  const result: TickResult = { evaluated: 0, fired: [], failed: [], skipped: 0, reaped: [], stuck: [], completed: [] };

  // Reap first (crash recovery / stuck detection) — always runs, even under the
  // kill switch (reaping is mechanism, not new firing). The `fire-due`
  // accelerator path skips it (reap: false).
  if (deps.reap !== false) {
    const reap = await reapStale(await listJobs(), attemptDeps);
    result.reaped = reap.reaped;
    result.stuck = reap.stuck;
    result.completed = reap.completed;
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
      if (!dispatcher) {
        throw new DispatchError(
          'the dashboard is not running, so there is no chat to post into — start it with `syntaur dashboard`',
        );
      }
      // Refuse before sending: a message into a room with nobody in it is an
      // error on the schedule, not a chat row nobody answers.
      await assertAgentAttached(dispatcher, current.assignmentId, current.agentId);
      const messageId = await dispatcher.send(current.assignmentId, current.agentId, current.message);
      current = await markDispatching(current, messageId, attemptDeps);
      // Recurring (cron): record the run AND re-arm in one atomic write
      // (crash-safe). One-shot: stay `running` until the turn ends (reapStale
      // reconciles it).
      current = isRecurring(current.trigger)
        ? await markRanAndReArm(current, attemptDeps)
        : await markRunning(current, attemptDeps);
      result.fired.push(current.id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      current = await markDispatchFailed(current, reason);
      await appendEvent(current.id, 'failed', { error: reason });
      deps.log?.(`schedule ${current.id} dispatch failed: ${reason}`);
      result.failed.push(current.id);
    }
  }

  return result;
}
