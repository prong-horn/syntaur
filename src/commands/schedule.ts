import { Command } from 'commander';
import { readConfig } from '../utils/config.js';
import { pickAgent } from '../launch/plan.js';
import { getSessionById } from '../dashboard/agent-sessions.js';
import { initSessionDb } from '../dashboard/session-db.js';
import type { TerminalChoice } from '../utils/config.js';
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
import { isScheduledSessionLive } from '../schedules/liveness.js';
import {
  assertUnattendedTerminalSupported,
} from '../schedules/unattended.js';
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
  if (opts.cron) chosen.push({ kind: 'cron', expr: opts.cron, ...(opts.tz ? { tz: opts.tz } : {}) });
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
  agent?: string;
  prompt?: string;
  playbook?: string;
  terminal?: string;
  interactive?: boolean;
  maxRuntime?: string;
  maxLaunchesPerDay?: string;
  cooldown?: string;
  note?: string;
}

scheduleCommand
  .command('create')
  .description('Create a scheduled job')
  .requiredOption('--assignment <id>', 'Target assignment id/slug the agent works on')
  .option('--agent <id>', 'Agent runner id (default: configured default agent)')
  .option('--prompt <template>', 'Launch-prompt template (@tokens allowed)')
  .option('--playbook <slug>', 'Playbook slug to drive the prompt')
  .option('--terminal <choice>', 'Terminal to launch in (default: configured)')
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
      const config = await readConfig();
      const agentId = opts.agent ?? pickAgent(config).id;
      const terminal = (opts.terminal as TerminalChoice | undefined) ?? null;
      const unattended = !opts.interactive;
      if (unattended) assertUnattendedTerminalSupported(terminal);

      const limits = defaultLimits();
      if (opts.maxRuntime) limits.maxRuntimeMs = parseDurationMs(opts.maxRuntime);
      if (opts.maxLaunchesPerDay) limits.maxLaunchesPerDay = Number.parseInt(opts.maxLaunchesPerDay, 10);
      if (opts.cooldown) limits.cooldownMs = parseDurationMs(opts.cooldown);

      const now = nowTimestamp();
      const job: ScheduledJob = {
        id: newJobId(),
        assignmentId: opts.assignment,
        agentId,
        promptTemplate: opts.prompt ?? null,
        playbook: opts.playbook ?? null,
        terminalPreference: terminal,
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
  .description('Kill a running scheduled job (signals the launched session)')
  .argument('<id>', 'Schedule id')
  .action(
    wrap(async (id: string) => {
      const job = await killJob(id, {
        signalTarget: ({ sessionId, launchPid }) => {
          // Prefer the tracked agent session's live pid; fall back to the
          // wrapper launchPid only if the session can't be resolved.
          let pid: number | null = null;
          if (sessionId) {
            try {
              initSessionDb();
              pid = getSessionById(sessionId)?.pid ?? null;
            } catch {
              pid = null;
            }
          }
          pid = pid ?? launchPid;
          if (pid) {
            try {
              process.kill(pid, 'SIGTERM');
            } catch {
              /* already gone */
            }
          }
        },
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
      const r = await runTick({ log: (m) => console.error(m), isSessionLive: isScheduledSessionLive });
      console.log(
        `tick: evaluated ${r.evaluated}, fired ${r.fired.length}, failed ${r.failed.length}, reaped ${r.reaped.length}, stuck ${r.stuck.length}`,
      );
    }),
  );

scheduleCommand
  .command('fire-due')
  .description('Internal: fire currently-due jobs without reaping (accelerator path)')
  .action(
    wrap(async () => {
      const r = await runTick({ reap: false, isSessionLive: isScheduledSessionLive });
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
