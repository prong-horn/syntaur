/**
 * `after-reset` trigger math (Task 6). Honest about its limits: there is NO
 * provider API that proves a quota reset, so v1 PREDICTS the next reset from a
 * user-supplied window anchor and RE-VERIFIES wall-clock at fire time. The
 * anchor is the source of truth and is user-correctable via `reschedule`.
 *
 * Kept dependency-free and isolated so a future real signal (a usage-db reader
 * that infers a reset from a counter drop) can swap in behind the same surface.
 */

import type { Provider, ResetAnchor } from './types.js';

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function windowLengthMs(anchor: ResetAnchor): number {
  return anchor.windowKind === 'weekly' ? ONE_WEEK_MS : FIVE_HOURS_MS;
}

/**
 * The first predicted reset *after* the anchored window start — i.e. the moment
 * the user's current quota window rolls over. One-shot by design: the trigger
 * is consumed (dedupe) once it fires, so we never chase later boundaries.
 *
 * `provider` is recorded for audit / future per-provider divergence; today the
 * window length derives from `windowKind`.
 */
export function predictReset(_provider: Provider, anchor: ResetAnchor): string {
  const start = Date.parse(anchor.windowStartIso);
  if (Number.isNaN(start)) {
    throw new Error(`Invalid reset anchor windowStartIso: ${anchor.windowStartIso}`);
  }
  return new Date(start + windowLengthMs(anchor)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface ResetVerification {
  /** True once `now` has reached the predicted reset → the job may fire. */
  eligible: boolean;
  /** When not eligible, the tick reschedules the job to this ISO time. */
  rescheduleToIso?: string;
}

/**
 * Re-verify at fire time. If `now` has reached the predicted reset the job is
 * eligible; otherwise it's a prediction that hasn't matured — reschedule to the
 * predicted time rather than firing (this is what makes `after-reset` a
 * prediction-with-re-verification, not a dumb alarm).
 */
export function verifyReset(provider: Provider, anchor: ResetAnchor, now: Date): ResetVerification {
  const reset = predictReset(provider, anchor);
  if (now.getTime() >= Date.parse(reset)) return { eligible: true };
  return { eligible: false, rescheduleToIso: reset };
}
