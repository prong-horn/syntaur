import { Command } from 'commander';
import {
  flagTicket,
  GateFailedError,
  moveTicket,
  unapproveTicket,
  VerbRefusedError,
  type VerbOptions,
} from '../lifecycle/verbs.js';

export interface VerbCommandOptions extends VerbOptions {}

function reportMove(ticketId: string, result: Awaited<ReturnType<typeof moveTicket>>): void {
  if (result.from === result.to) {
    console.log(`${ticketId}: ${result.verb} completed (no stage change).`);
  } else {
    console.log(`${ticketId}: ${result.from} → ${result.to} (${result.verb})`);
  }
}

async function runVerb(
  ticketId: string,
  verb: Parameters<typeof moveTicket>[1],
  options: VerbCommandOptions,
): Promise<void> {
  const result = await moveTicket(ticketId, verb, options);
  reportMove(ticketId, result);
}

async function runFlag(
  ticketId: string,
  flag: Parameters<typeof flagTicket>[1],
  reason: string | null,
  options: VerbCommandOptions,
): Promise<void> {
  await flagTicket(ticketId, flag, reason, options);
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
    .option('--agent <name>', 'Acting agent id')
    .option('--project <slug>', 'Project slug for a project-nested ticket');

export function registerVerbCommands(program: Command): void {
  verbOptions(
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
          await unapproveTicket(ticketId, options);
          console.log(`${ticketId}: plan approval cleared.`);
        } catch (error) {
          console.error('Error:', error instanceof Error ? error.message : String(error));
          process.exit(1);
        }
      }),
  );

  verbOptions(
    program
      .command('start')
      .description('Move to in_progress')
      .argument('<ticket>', 'Ticket id')
      .action(verbAction('start')),
  );

  verbOptions(
    program
      .command('review')
      .description('Move to review')
      .argument('<ticket>', 'Ticket id')
      .action(verbAction('review')),
  );

  verbOptions(
    program
      .command('done')
      .description('Move to done')
      .argument('<ticket>', 'Ticket id')
      .action(verbAction('done')),
  );

  verbOptions(
    program
      .command('drop')
      .description('Drop the ticket (requires a reason)')
      .argument('<ticket>', 'Ticket id')
      .argument('<reason>', 'Reason for dropping')
      .action(verbAction('drop', true)),
  );

  verbOptions(
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
