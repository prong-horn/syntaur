/**
 * Trigger evaluation (Task 5) — the predicate layer of the scheduler. PURE over
 * an injected `now` and the watched assignment's *persisted* frontmatter; it
 * never reads live state and never mutates. It only REPORTS a due edge + its
 * dedupe key; the cursor/dedupe advance is persisted by the attempt state
 * machine inside the claimed transition, BEFORE launch (crash-safe exactly-once).
 *
 * State triggers read `statusHistory` / `planApproval` via the EXPORTED
 * `parseAssignmentFrontmatter` (NOT the internal `parseStatusHistory`). The tick
 * reads the assignment once and passes the parsed frontmatter in as context, so
 * this module stays unit-testable without touching the filesystem.
 */

import { Cron } from 'croner';
import type { AssignmentFrontmatter } from '../lifecycle/types.js';
import { predictReset, verifyReset } from './reset-window.js';
import { type ScheduledJob, type JobTrigger } from './types.js';

export interface TriggerContext {
  now: Date;
  /**
   * Parsed frontmatter of the assignment a state trigger watches. `null` when it
   * couldn't be read — state triggers then report not-due (fail closed). Unused
   * by clock / after-reset triggers.
   */
  assignment?: AssignmentFrontmatter | null;
}

export interface TriggerEvaluation {
  due: boolean;
  /** Identity of the fired edge — recorded in `attempt.consumedEdges`. */
  dedupeKey?: string;
  /** For state triggers: the cursor value to persist when the edge is claimed. */
  nextCursor?: number;
  /** Human/next-fire display for clock triggers (and reschedule target). */
  nextFireIso?: string | null;
  /** For `after-reset` not-yet-matured: the tick reschedules to here. */
  rescheduleToIso?: string;
}

function iso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Recurring triggers re-arm after a successful fire (the next occurrence is a
 * new edge); one-shot triggers stay `running` after their single fire. Only
 * `cron` recurs in v1.
 */
export function isRecurring(trigger: JobTrigger): boolean {
  return trigger.kind === 'cron';
}

const notDue: TriggerEvaluation = { due: false };

/** Evaluate a job's trigger against persisted state. */
export function evaluateTrigger(job: ScheduledJob, ctx: TriggerContext): TriggerEvaluation {
  const consumed = new Set(job.attempt.consumedEdges);
  const result = evaluateKind(job.trigger, job, ctx);
  if (result.due && result.dedupeKey && consumed.has(result.dedupeKey)) {
    // This exact edge already fired — surface next-fire but not due.
    return { ...result, due: false };
  }
  return result;
}

function evaluateKind(trigger: JobTrigger, job: ScheduledJob, ctx: TriggerContext): TriggerEvaluation {
  // Creation baseline: a newly-created schedule must react only to FUTURE edges,
  // never replay history (a cron job made at 16:00 must not fire for today's
  // already-past 03:00; a state/plan job must not fire on an edge that happened
  // before it existed). `createdAt` is that universal cutoff.
  const createdAtMs = Date.parse(job.createdAt);
  switch (trigger.kind) {
    case 'at': {
      const at = Date.parse(trigger.at);
      const due = !Number.isNaN(at) && ctx.now.getTime() >= at;
      return { due, dedupeKey: `at:${trigger.at}`, nextFireIso: trigger.at };
    }
    case 'in': {
      const anchor = Date.parse(trigger.anchorIso);
      const fireAt = anchor + trigger.durationMs;
      const due = !Number.isNaN(anchor) && ctx.now.getTime() >= fireAt;
      const fireIso = Number.isNaN(anchor) ? null : iso(new Date(fireAt));
      return { due, dedupeKey: `in:${fireAt}`, nextFireIso: fireIso };
    }
    case 'cron':
      return evaluateCron(trigger, ctx.now, createdAtMs);
    case 'after-reset':
      return evaluateAfterReset(trigger, ctx.now);
    case 'when-status':
      return evaluateWhenStatus(trigger, job, ctx, createdAtMs);
    case 'when-plan-lands':
      return evaluateWhenPlanLands(ctx, createdAtMs);
  }
}

function evaluateCron(
  trigger: Extract<JobTrigger, { kind: 'cron' }>,
  now: Date,
  createdAtMs: number,
): TriggerEvaluation {
  // Croner throws on a malformed expr at construction AND on an invalid IANA tz
  // LATER, inside previousRuns()/nextRun(). Both must be caught here so a single
  // bad-config job degrades to "not due" instead of throwing out of
  // evaluateTrigger and aborting the whole scheduler tick. Validation at create
  // time (buildTrigger) keeps bad config from being persisted in the first place;
  // this is the runtime safety net.
  try {
    const cron = new Cron(trigger.expr, trigger.tz ? { timezone: trigger.tz } : {});
    // The most recent scheduled occurrence at-or-before `now`. croner's
    // `previousRun()` reads the REAL clock, so we use `previousRuns(1, ref)` which
    // accepts an explicit reference — that's what makes this injected-clock-pure.
    // croner floors to whole seconds, so the reference is `now + 1s` to include an
    // occurrence landing exactly on `now`; the `> now` guard discards the rare
    // sub-second overshoot (6-part second-granular crons). Each occurrence fires
    // exactly once via its timestamp dedupe key.
    const prevs = cron.previousRuns(1, new Date(now.getTime() + 1000));
    let prev = prevs.length > 0 ? prevs[0] : null;
    if (prev && prev.getTime() > now.getTime()) prev = null;
    // Don't fire for an occurrence that predates the schedule's creation.
    if (prev && !Number.isNaN(createdAtMs) && prev.getTime() < createdAtMs) prev = null;
    const next = cron.nextRun(now);
    if (!prev) return { due: false, nextFireIso: next ? iso(next) : null };
    return { due: true, dedupeKey: `cron:${iso(prev)}`, nextFireIso: next ? iso(next) : null };
  } catch {
    return notDue;
  }
}

function evaluateAfterReset(
  trigger: Extract<JobTrigger, { kind: 'after-reset' }>,
  now: Date,
): TriggerEvaluation {
  const v = verifyReset(trigger.provider, trigger.anchor, now);
  const predicted = predictReset(trigger.provider, trigger.anchor);
  if (v.eligible) {
    return { due: true, dedupeKey: `after-reset:${trigger.anchor.windowStartIso}`, nextFireIso: predicted };
  }
  return { due: false, nextFireIso: predicted, rescheduleToIso: v.rescheduleToIso };
}

function evaluateWhenStatus(
  trigger: Extract<JobTrigger, { kind: 'when-status' }>,
  job: ScheduledJob,
  ctx: TriggerContext,
  createdAtMs: number,
): TriggerEvaluation {
  const fm = ctx.assignment;
  if (!fm) return notDue; // fail closed — couldn't read the watched assignment
  const history = fm.statusHistory ?? [];
  for (let i = job.attempt.cursor; i < history.length; i++) {
    // Only fire on a transition into the target status that happened AT/AFTER
    // the schedule was created — never replay a pre-existing history edge.
    const atMs = Date.parse(history[i].at);
    const afterCreation = Number.isNaN(createdAtMs) || Number.isNaN(atMs) || atMs >= createdAtMs;
    if (history[i].to === trigger.status && afterCreation) {
      return { due: true, dedupeKey: `status:${i}:${history[i].at}`, nextCursor: i + 1 };
    }
  }
  return { due: false, nextCursor: history.length };
}

function evaluateWhenPlanLands(ctx: TriggerContext, createdAtMs: number): TriggerEvaluation {
  const fm = ctx.assignment;
  if (!fm) return notDue;
  const approval = fm.planApproval;
  if (!approval) return notDue;
  // Only fire if the plan landed AT/AFTER the schedule was created (don't fire
  // on a plan that was already approved before the schedule existed).
  const approvedMs = Date.parse(approval.at);
  if (!Number.isNaN(createdAtMs) && !Number.isNaN(approvedMs) && approvedMs < createdAtMs) {
    return notDue;
  }
  // Dedupe on the approval revision so re-approving the SAME revision doesn't
  // refire, but a NEW revision (replan → new file/digest) can.
  return { due: true, dedupeKey: `plan:${approval.file}:${approval.digest}` };
}
