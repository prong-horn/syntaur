/**
 * Unattended permission mode + hard limits + kill switch (Task 9). Unattended is
 * a DISTINCT trust model from interactive: a scheduled job fires with no human
 * watching, so it is gated by hard limits (cooldown, launches-per-day, runtime,
 * token/spend budget) and a global kill switch before it may fire.
 *
 * SCOPE NOTE (v1): this module enforces the *gates*. Injecting the agent's
 * actual permission-mode/allowlist flags into the launched argv is the seam left
 * for when the launch spec gains unattended fields (it overlaps the deferred
 * headless work) — `unattendedArgvSeam` marks where that plugs in. The job's
 * `limits.toolAllowlist`/budgets are persisted intent today; the runtime
 * enforcement of token/spend budgets lives with the agent runner, not here.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TerminalChoice } from '../utils/config.js';
import { schedulesDir } from './store.js';
import type { ScheduledJob } from './types.js';

export class UnattendedRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnattendedRefusalError';
  }
}

/**
 * Warp opens a window but cannot auto-start the command, so an unattended Warp
 * job would never ack. Refuse it at create time (interactive Warp is unaffected).
 */
export function assertUnattendedTerminalSupported(terminal: TerminalChoice | null): void {
  if (terminal === 'warp') {
    throw new UnattendedRefusalError(
      'Warp cannot auto-start a command, so it cannot run an unattended scheduled job. Pick another terminal or schedule it interactively.',
    );
  }
}

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
 * Seam for injecting unattended permission-mode flags into the launched agent
 * argv. Returns nothing today; when the launch spec gains unattended fields,
 * this returns the per-agent skip-permissions / allowlist flags. Kept as a named
 * function so the wiring point is greppable and the intent (`limits`) is already
 * carried on the job.
 */
export function unattendedArgvSeam(_job: ScheduledJob): string[] {
  return [];
}
