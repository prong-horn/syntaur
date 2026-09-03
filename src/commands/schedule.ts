import { Command } from 'commander';
import { Cron } from 'croner';
import {
  newJobId,
  readJob,
  writeJob,
  listJobs,
} from '../schedules/store.js';
import { describeTrigger } from '../schedules/store.js';
import { appendEvent, readEvents } from '../schedules/event-log.js';
import {
  cancelJob,
  retryJob,
  holdJob,
  releaseJob,
  killJob,
  rescheduleJob,
} from '../schedules/attempt.js';
import { runTick } from '../schedules/tick.js';
import { readDashboardPort, restDispatcher } from '../schedules/dispatch.js';
import { messageTurnOpenVia } from '../schedules/liveness.js';
import { installLaunchAgent, uninstallLaunchAgent } from '../schedules/launchd.js';
import {
  type ScheduledJob,
  type JobTrigger,
  type Provider,
  freshAttempt,
  defaultLimits,
  defaultTiming,
} from '../schedules/types.js';
import { nowTimestamp } from '../utils/timestamp.js';

const DURATION_REGEX = /^(\d+)\s*(s|m|h|d)?$/i;

function parseDurationMs(input: string): number {
  const m = DURATION_REGEX.exec(input.trim());
  if (!m) throw new Error(`invalid duration "${input}" — use e.g. 30s, 5m, 2h, 1d`);
  const n = Number.parseInt(m[1], 10);
  const mult: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return n * mult[(m[2] ?? 's').toLowerCase()];
}

/**
 * Where a `schedule tick`/`fire-due` run outside the dashboard posts its
 * messages. The CLI never holds a broker, so it goes through the chat REST
 * routes on the running dashboard; with none running, every due job records an
 * error (Decision 3 — no terminal fallback).
 */
async function restTickDeps(): Promise<{
  dashboardPort: number | null;
  isMessageTurnOpen?: ReturnType<typeof messageTurnOpenVia>;
}> {
  const port = await readDashboardPort();
  if (port === null) return { dashboardPort: null };
  return { dashboardPort: port, isMessageTurnOpen: messageTurnOpenVia(restDispatcher({ port })) };
}

interface TriggerOpts {
  at?: string;
  in?: string;
  cron?: string;
  tz?: string;
  afterReset?: string;
  windowStart?: string;
  windowKind?: string;
  whenStatus?: string;
  watchAssignment?: string;
  whenPlanLands?: boolean;
}

/** Build exactly one trigger from the provided flags (errors on 0 or >1). */
function buildTrigger(opts: TriggerOpts): JobTrigger {
  const chosen: JobTrigger[] = [];
  if (opts.at) chosen.push({ kind: 'at', at: opts.at });
  if (opts.in) chosen.push({ kind: 'in', durationMs: parseDurationMs(opts.in), anchorIso: nowTimestamp() });
  if (opts.cron) {
    // Validate the cron expression and timezone at create time. Croner throws on
    // a malformed expr at construction and on an invalid IANA tz inside
    // nextRun() — without this, a bad expr silently never fires (caught → notDue
    // forever) and a bad tz would crash the scheduler tick. Validate expr and tz
    // separately so the error names the actual problem.
    try {
      new Cron(opts.cron).nextRun();
    } catch {
      throw new Error(`invalid --cron expression: ${JSON.stringify(opts.cron)}`);
    }
    if (opts.tz) {
      try {
        new Cron(opts.cron, { timezone: opts.tz }).nextRun();
      } catch {
        throw new Error(`invalid --tz timezone: ${JSON.stringify(opts.tz)}`);
      }
    }
    chosen.push({ kind: 'cron', expr: opts.cron, ...(opts.tz ? { tz: opts.tz } : {}) });
  }
  if (opts.afterReset) {
    const provider = opts.afterReset as Provider;
    if (provider !== 'claude' && provider !== 'codex') {
      throw new Error('--after-reset must be claude or codex');
    }
    chosen.push({
      kind: 'after-reset',
      provider,
      anchor: {
        windowStartIso: opts.windowStart ?? nowTimestamp(),
        windowKind: opts.windowKind === 'weekly' ? 'weekly' : 'rolling-5h',
      },
    });
  }
  if (opts.whenStatus) {
    chosen.push({ kind: 'when-status', status: opts.whenStatus, ...(opts.watchAssignment ? { assignmentId: opts.watchAssignment } : {}) });
  }
  if (opts.whenPlanLands) {
    chosen.push({ kind: 'when-plan-lands', ...(opts.watchAssignment ? { assignmentId: opts.watchAssignment } : {}) });
  }
  if (chosen.length === 0) {
    throw new Error('a trigger is required: one of --at, --in, --cron, --after-reset, --when-status, --when-plan-lands');
  }
  if (chosen.length > 1) {
    throw new Error('exactly one trigger may be specified');
  }
  return chosen[0];
}

function die(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function wrap<A extends unknown[]>(fn: (...args: A) => Promise<void> | void) {
  return async (...args: A): Promise<void> => {
    try {
      await fn(...args);
    } catch (err) {
      die(err instanceof Error ? err.message : String(err));
    }
  };
}

export const scheduleCommand = new Command('schedule').description(
  'Scheduled agents — run work on an assignment unattended (clock / reset / state triggers)',
);

// --- create ----------------------------------------------------------------

interface CreateOpts extends TriggerOpts {
  assignment: string;
  message?: string;
  agent?: string;
  interactive?: boolean;
  maxRuntime?: string;
  maxLaunchesPerDay?: string;
  cooldown?: string;
  note?: string;
}

scheduleCommand
  .command('create')
  .description('Create a scheduled job — it posts a message into the assignment\'s chat')
  .requiredOption('--assignment <id>', 'Target assignment id/slug whose chat the message goes to')
  // A plain option, validated in the action, so a missing --message is our own
  // `Error: ...` line rather than commander's raw usage dump.
  .option('--message <text>', 'The chat message to post on every fire')
  .option('--agent <id>', 'Chat agent id to address (default: the assignment\'s default agent)')
  .option('--interactive', 'Interactive (not unattended) — skips the unattended trust gates')
  .option('--at <ts>', 'Clock trigger: fire at an ISO timestamp')
  .option('--in <duration>', 'Clock trigger: fire after a duration (e.g. 5h)')
  .option('--cron <expr>', 'Clock trigger: cron expression')
  .option('--tz <tz>', 'Timezone for --cron (default: local)')
  .option('--after-reset <provider>', 'Reset trigger: claude|codex')
  .option('--window-start <ts>', 'Quota window start anchor for --after-reset')
  .option('--window-kind <kind>', 'rolling-5h|weekly (default rolling-5h)')
  .option('--when-status <status>', 'State trigger: fire when the assignment reaches a status')
  .option('--when-plan-lands', 'State trigger: fire when the plan lands (planApproval set)')
  .option('--watch-assignment <id>', 'Assignment to watch for state triggers (default: --assignment)')
  .option('--max-runtime <duration>', 'Hard limit: max runtime before "stuck"')
  .option('--max-launches-per-day <n>', 'Hard limit: launches/day')
  .option('--cooldown <duration>', 'Hard limit: min gap between launches')
  .option('--note <text>', 'Human note')
  .action(
    wrap(async (opts: CreateOpts) => {
      if (!opts.message || opts.message.trim().length === 0) {
        throw new Error('--message is required — it is what gets posted into the assignment\'s chat');
      }
      const unattended = !opts.interactive;

      const limits = defaultLimits();
      if (opts.maxRuntime) limits.maxRuntimeMs = parseDurationMs(opts.maxRuntime);
      if (opts.maxLaunchesPerDay) {
        // Number(), not parseInt: parseInt('1abc')===1 and parseInt('1.5')===1
        // would silently accept garbage. A NaN/≤0 limit makes `count >= limit`
        // always false in canFire — i.e. the cap is silently disabled.
        const n = Number(opts.maxLaunchesPerDay);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error('--max-launches-per-day must be a positive integer');
        }
        limits.maxLaunchesPerDay = n;
      }
      if (opts.cooldown) limits.cooldownMs = parseDurationMs(opts.cooldown);

      const now = nowTimestamp();
      const job: ScheduledJob = {
        id: newJobId(),
        assignmentId: opts.assignment,
        agentId: opts.agent ?? null,
        message: opts.message,
        unattended,
        limits,
        trigger: buildTrigger(opts),
        timing: defaultTiming(),
        attempt: freshAttempt(),
        createdAt: now,
        updatedAt: now,
        note: opts.note ?? null,
      };
      const written = await writeJob(job);
      await appendEvent(written.id, 'created', { trigger: written.trigger.kind });
      console.log(`Created schedule ${written.id} — ${describeTrigger(written.trigger)} (${unattended ? 'unattended' : 'interactive'}).`);
    }),
  );

// --- list / show -----------------------------------------------------------

scheduleCommand
  .command('list')
  .description('List scheduled jobs')
  .option('--json', 'Emit JSON')
  .action(
    wrap(async (opts: { json?: boolean }) => {
      const jobs = await listJobs();
      if (opts.json) {
        console.log(JSON.stringify(jobs, null, 2));
        return;
      }
      if (jobs.length === 0) {
        console.log('No scheduled jobs.');
        return;
      }
      for (const j of jobs) {
        console.log(`${j.id}  [${j.attempt.state}]  ${j.assignmentId}  — ${describeTrigger(j.trigger)}`);
      }
    }),
  );

scheduleCommand
  .command('show')
  .description('Show a scheduled job and its recent events')
  .argument('<id>', 'Schedule id')
  .action(
    wrap(async (id: string) => {
      const job = await readJob(id);
      if (!job) die(`No such schedule: ${id}`);
      console.log(JSON.stringify(job, null, 2));
      const events = await readEvents(id);
      console.log(`\nEvents (${events.length}):`);
      for (const e of events.slice(-20)) console.log(`  ${e.at}  ${e.type}${e.data ? `  ${JSON.stringify(e.data)}` : ''}`);
    }),
  );

// --- control verbs ---------------------------------------------------------

function controlVerb(name: string, fn: (id: string) => Promise<ScheduledJob>, past: string): void {
  scheduleCommand
    .command(name)
    .description(`${past} a scheduled job`)
    .argument('<id>', 'Schedule id')
    .action(
      wrap(async (id: string) => {
        const job = await fn(id);
        console.log(`${past} ${id} → ${job.attempt.state}`);
      }),
    );
}

controlVerb('cancel', cancelJob, 'Cancelled');
controlVerb('retry', retryJob, 'Re-armed');
controlVerb('hold', holdJob, 'Held');
controlVerb('release', releaseJob, 'Released');

scheduleCommand
  .command('kill')
  .description('Kill a running scheduled job (withdraws its queued message, or cancels its turn)')
  .argument('<id>', 'Schedule id')
  .action(
    wrap(async (id: string) => {
      const port = await readDashboardPort();
      if (port === null) {
        throw new Error(
          'the dashboard is not running, so the chat cannot be reached — start it with `syntaur dashboard`, or use `syntaur schedule cancel` to just mark the job',
        );
      }
      const chat = restDispatcher({ port });
      const job = await killJob(id, {
        withdrawMessage: (assignmentId, messageId) => chat.withdraw(assignmentId, messageId),
        cancelTurn: (assignmentId, agentId) => chat.cancel(assignmentId, agentId),
      });
      console.log(`Killed ${id} → ${job.attempt.state}`);
    }),
  );

scheduleCommand
  .command('reschedule')
  .description('Change a job\'s trigger and re-arm it')
  .argument('<id>', 'Schedule id')
  .option('--at <ts>', 'fire at an ISO timestamp')
  .option('--in <duration>', 'fire after a duration')
  .option('--cron <expr>', 'cron expression')
  .option('--tz <tz>', 'timezone for --cron')
  .option('--after-reset <provider>', 'claude|codex')
  .option('--window-start <ts>', 'quota window start anchor')
  .option('--window-kind <kind>', 'rolling-5h|weekly')
  .option('--when-status <status>', 'fire when the assignment reaches a status')
  .option('--when-plan-lands', 'fire when the plan lands')
  .option('--watch-assignment <id>', 'assignment to watch for state triggers')
  .action(
    wrap(async (id: string, opts: TriggerOpts) => {
      const trigger = buildTrigger(opts);
      const job = await rescheduleJob(id, trigger);
      console.log(`Rescheduled ${id} → ${describeTrigger(job.trigger)}`);
    }),
  );

// --- scheduler authority ---------------------------------------------------

scheduleCommand
  .command('tick')
  .description('Run one scheduler tick (the one authority): evaluate, fire due, reap')
  .action(
    wrap(async () => {
      const r = await runTick({ log: (m) => console.error(m), ...(await restTickDeps()) });
      console.log(
        `tick: evaluated ${r.evaluated}, fired ${r.fired.length}, failed ${r.failed.length}, reaped ${r.reaped.length}, stuck ${r.stuck.length}, completed ${r.completed.length}`,
      );
    }),
  );

scheduleCommand
  .command('fire-due')
  .description('Internal: fire currently-due jobs without reaping (accelerator path)')
  .action(
    wrap(async () => {
      const r = await runTick({ reap: false, ...(await restTickDeps()) });
      console.log(`fire-due: fired ${r.fired.length}, failed ${r.failed.length}`);
    }),
  );

// --- launchd install/uninstall ---------------------------------------------

scheduleCommand
  .command('install')
  .description('Install the macOS LaunchAgent that runs `schedule tick` on an interval')
  .option('--interval <seconds>', 'tick interval in seconds (default 60)')
  .action(
    wrap(async (opts: { interval?: string }) => {
      const res = installLaunchAgent({
        intervalSeconds: opts.interval ? Number.parseInt(opts.interval, 10) : undefined,
      });
      console.log(`Installed ${res.label} (every ${res.intervalSeconds}s) → ${res.plistPath}`);
      console.log('Note: v1 fires only while this Mac is awake + logged in (wake-from-sleep is deferred).');
    }),
  );

scheduleCommand
  .command('uninstall')
  .description('Uninstall the macOS LaunchAgent')
  .action(
    wrap(async () => {
      const res = uninstallLaunchAgent();
      console.log(`Uninstalled ${res.label} (removed ${res.plistPath}).`);
    }),
  );
