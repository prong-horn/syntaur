/**
 * Unattended permission mode + hard limits + kill switch (Task 9). Unattended is
 * a DISTINCT trust model from interactive: a scheduled job fires with no human
 * watching, so it is gated by hard limits (cooldown, dispatches-per-day,
 * runtime, token/spend budget) and a global kill switch before it may fire.
 *
 * SCOPE NOTE (v1): this module enforces the *gates*. Pinning the dispatched
 * turn's actual permission mode / tool allowlist is the seam left for when the
 * chat gains per-turn pinning — `unattendedArgvSeam` marks where that plugs in.
 * The job's `limits.toolAllowlist`/budgets are persisted intent today; the
 * runtime enforcement of token/spend budgets lives with the agent, not here.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { schedulesDir } from './store.js';
import type { ScheduledJob } from './types.js';

/**
 * Global kill switch: a `KILL` file in the schedules dir or
 * `SYNTAUR_SCHEDULES_DISABLED=1`. When engaged, the tick fires nothing.
 */
export function isKillSwitchEngaged(): boolean {
  if (process.env.SYNTAUR_SCHEDULES_DISABLED === '1') return true;
  return existsSync(resolve(schedulesDir(), 'KILL'));
}

export interface FireGateDeps {
  now: () => Date;
  /** Override the kill-switch probe (tests). Defaults to `isKillSwitchEngaged`. */
  killSwitch?: () => boolean;
}

export interface FireDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Decide whether an (unattended) job may fire right now, given its hard limits.
 * Pure over an injected clock. Returns a reason on denial so the tick can log it
 * without consuming the trigger edge (a cooldown/limit denial retries next tick).
 */
export function canFire(job: ScheduledJob, deps: FireGateDeps): FireDecision {
  const killSwitch = deps.killSwitch ?? isKillSwitchEngaged;
  if (killSwitch()) return { allowed: false, reason: 'kill-switch-engaged' };

  // Interactive jobs aren't gated by the unattended trust model.
  if (!job.unattended) return { allowed: true };

  const now = deps.now();
  const { limits, attempt } = job;

  if (limits.cooldownMs && attempt.lastFiredAt) {
    const since = now.getTime() - Date.parse(attempt.lastFiredAt);
    if (since < limits.cooldownMs) return { allowed: false, reason: 'cooldown' };
  }

  if (limits.maxLaunchesPerDay != null) {
    const today = now.toISOString().slice(0, 10);
    const todayCount = attempt.launchDayStamps.filter((d) => d === today).length;
    if (todayCount >= limits.maxLaunchesPerDay) {
      return { allowed: false, reason: 'max-launches-per-day' };
    }
  }

  return { allowed: true };
}

/**
 * Seam for injecting unattended permission-mode intent into the dispatched
 * turn. Returns nothing today; when the chat gains per-turn mode/allowlist
 * pinning this returns it. Kept as a named function so the wiring point is
 * greppable and the intent (`limits`) is already carried on the job.
 */
export function unattendedArgvSeam(_job: ScheduledJob): string[] {
  return [];
}
