import { Command } from 'commander';
import {
  flagTicket,
  GateFailedError,
  moveTicket,
  unapproveTicket,
  VerbRefusedError,
  resolveLifecycleActor,
  resolveLifecycleCaller,
  type VerbOptions,
  type MoveTicketResult,
} from '../lifecycle/verbs.js';
import { postCliStageDispatch, readDashboardPort } from '../chat/dispatch-client.js';
import type { DispatchResult } from '../lifecycle/stage-entry.js';

export interface VerbCommandOptions extends VerbOptions {}

export function formatDispatchLines(
  ticketId: string,
  dispatch: DispatchResult | undefined,
  port: number | null,
): string[] {
  if (!dispatch) return [];
  const lines: string[] = [];
  if (dispatch.state === 'queued' && dispatch.requestId) {
    lines.push(`Dispatch: queued (${dispatch.requestId})`);
    if (port !== null) {
      lines.push(
        `Cancel: curl -s -X POST http://127.0.0.1:${port}/api/tickets/${ticketId}/dispatch/${dispatch.requestId}/cancel`,
      );
    } else {
      lines.push(
        `Cancel: POST /api/tickets/${ticketId}/dispatch/${dispatch.requestId}/cancel on the dashboard`,
      );
    }
  } else if (dispatch.state === 'offline') {
    lines.push(`Dispatch: offline${dispatch.warning ? ` — ${dispatch.warning}` : ''}`);
  } else if (dispatch.state === 'unknown') {
    lines.push(`Dispatch: unknown${dispatch.warning ? ` — ${dispatch.warning}` : ''}`);
  } else if (dispatch.state === 'failed') {
    lines.push(`Dispatch: failed${dispatch.error ? ` — ${dispatch.error}` : ''}`);
  } else if (dispatch.state === 'skipped') {
    lines.push('Dispatch: manual handoff required');
  } else if (dispatch.state === 'suppressed') {
    lines.push('Dispatch: suppressed (--no-dispatch); hand off manually when ready');
  }
  return lines;
}

async function reportMove(ticketId: string, result: MoveTicketResult): Promise<void> {
  if (result.from === result.to) {
    console.log(`${ticketId}: ${result.verb} completed (no stage change).`);
  } else {
    console.log(`${ticketId}: ${result.from} → ${result.to} (${result.verb})`);
  }
  const port =
    result.dispatch?.state === 'queued' ? await readDashboardPort() : null;
  for (const line of formatDispatchLines(ticketId, result.dispatch, port)) {
    console.log(line);
  }
  for (const warning of result.warnings ?? []) {
    console.warn(`Warning: ${warning}`);
  }
}

async function runVerb(
  ticketId: string,
  verb: Parameters<typeof moveTicket>[1],
  options: VerbCommandOptions,
): Promise<void> {
  const cli = options as VerbCommandOptions & {
    by?: string;
    agent?: string;
    dispatch?: boolean;
  };
  const actor = resolveCliActor({ ...options, actor: cli.by ?? options.actor });
  const callerSession = await resolveLifecycleCaller(options);
  const dispatchAgent = verb === 'start' ? (cli.agent ?? options.dispatchAgent) : undefined;
  const suppressDispatch = cli.dispatch === false;
  const result = await moveTicket(ticketId, verb, {
    force: options.force,
    actor,
    callerSession,
    dispatchAgent,
    suppressDispatch,
    reason: options.reason,
    cwd: options.cwd,
    dir: options.dir,
    project: options.project,
    dispatch: postCliStageDispatch,
  });
  await reportMove(ticketId, result);
}

function resolveCliActor(options: VerbCommandOptions): string {
  const cli = options as VerbCommandOptions & { by?: string };
  return resolveLifecycleActor({ ...options, actor: cli.by ?? options.actor });
}

async function runFlag(
  ticketId: string,
  flag: Parameters<typeof flagTicket>[1],
  reason: string | null,
  options: VerbCommandOptions,
): Promise<void> {
  await flagTicket(ticketId, flag, reason, {
    ...options,
    actor: resolveCliActor(options),
  });
  console.log(`${ticketId}: ${flag} applied.`);
}

function verbAction(
  verb: Parameters<typeof moveTicket>[1],
  needsReason = false,
): (ticketId: string, reasonOrOpts: string | VerbCommandOptions, maybeOpts?: VerbCommandOptions) => Promise<void> {
  return async (ticketId, reasonOrOpts, maybeOpts) => {
    try {
      const options: VerbCommandOptions =
        typeof reasonOrOpts === 'string' ? { ...maybeOpts, reason: reasonOrOpts } : reasonOrOpts;
      if (needsReason && !options.reason?.trim()) {
        throw new VerbRefusedError(`Cannot ${verb} ${ticketId}: reason is required`);
      }
      await runVerb(ticketId, verb, options);
    } catch (error) {
      if (error instanceof GateFailedError) {
        console.error(error.message);
        process.exit(1);
      }
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  };
}

function flagAction(
  flag: Parameters<typeof flagTicket>[1],
  needsReason = false,
): (ticketId: string, reasonOrOpts: string | VerbCommandOptions, maybeOpts?: VerbCommandOptions) => Promise<void> {
  return async (ticketId, reasonOrOpts, maybeOpts) => {
    try {
      const options: VerbCommandOptions =
        typeof reasonOrOpts === 'string' ? { ...maybeOpts, reason: reasonOrOpts } : reasonOrOpts;
      const reason = typeof reasonOrOpts === 'string' ? reasonOrOpts : options.reason ?? null;
      if (needsReason && !reason?.trim()) {
        throw new VerbRefusedError(`Cannot ${flag} ${ticketId}: reason is required`);
      }
      await runFlag(ticketId, flag, reason, options);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  };
}

const verbOptions = (cmd: Command): Command =>
  cmd
    .option('--force', 'Skip gate checks (recorded on the moved event)')
    .option('--by <name>', 'Audit attribution for this action')
    .option('--project <slug>', 'Project slug for a project-nested ticket');

const moveOptions = (cmd: Command): Command =>
  verbOptions(cmd).option(
    '--no-dispatch',
    'Record the move without the automatic stage handoff (hand off manually later)',
  );

const startOptions = (cmd: Command): Command =>
  moveOptions(cmd).option(
    '--agent <id>',
    'Dispatch recipient override for this start only (not audit attribution)',
  );

export function registerVerbCommands(program: Command): void {
  moveOptions(
    program
      .command('approve')
      .description('Approve the plan and move to ready when declared')
      .argument('<ticket>', 'Ticket id')
      .action(verbAction('approve')),
  );

  verbOptions(
    program
      .command('unapprove')
      .description('Clear plan approval without changing stage')
      .argument('<ticket>', 'Ticket id')
      .action(async (ticketId: string, options: VerbCommandOptions) => {
        try {
          await unapproveTicket(ticketId, { ...options, actor: resolveCliActor(options) });
          console.log(`${ticketId}: plan approval cleared.`);
        } catch (error) {
          console.error('Error:', error instanceof Error ? error.message : String(error));
          process.exit(1);
        }
      }),
  );

  startOptions(
    program
      .command('start')
      .description('Move to in_progress')
      .argument('<ticket>', 'Ticket id')
      .action(verbAction('start')),
  );

  moveOptions(
    program
      .command('review')
      .description('Move to review')
      .argument('<ticket>', 'Ticket id')
      .action(verbAction('review')),
  );

  moveOptions(
    program
      .command('done')
      .description('Move to done')
      .argument('<ticket>', 'Ticket id')
      .action(verbAction('done')),
  );

  moveOptions(
    program
      .command('drop')
      .description('Drop the ticket (requires a reason)')
      .argument('<ticket>', 'Ticket id')
      .argument('<reason>', 'Reason for dropping')
      .action(verbAction('drop', true)),
  );

  moveOptions(
    program
      .command('reopen')
      .description('Reopen from done or dropped')
      .argument('<ticket>', 'Ticket id')
      .action(verbAction('reopen')),
  );

  verbOptions(
    program
      .command('block')
      .description('Block the ticket with a reason (does not change stage)')
      .argument('<ticket>', 'Ticket id')
      .argument('<reason>', 'Block reason')
      .action(flagAction('block', true)),
  );

  verbOptions(
    program
      .command('unblock')
      .description('Clear the blocked flag')
      .argument('<ticket>', 'Ticket id')
      .action(flagAction('unblock')),
  );

  verbOptions(
    program
      .command('park')
      .description('Park the ticket with a reason (does not change stage)')
      .argument('<ticket>', 'Ticket id')
      .argument('<reason>', 'Park reason')
      .action(flagAction('park', true)),
  );

  verbOptions(
    program
      .command('unpark')
      .description('Clear the parked flag')
      .argument('<ticket>', 'Ticket id')
      .action(flagAction('unpark')),
  );
}
