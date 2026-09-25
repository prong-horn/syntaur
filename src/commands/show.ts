import { Command } from 'commander';
import { resolveSessionEngagement } from '../utils/engagement-binding.js';
import { resolveTicketTarget } from '../utils/ticket-target.js';
import { assertMayMutate } from '../utils/session-id.js';
import { syntaurRoot } from '../utils/paths.js';
import { buildShow, renderLogOnly, renderShowText } from '../ticket-templates/show.js';

async function resolveShowTarget(opts: {
  ticket?: string;
  project?: string;
  cwd?: string;
}): Promise<{ ticketDir: string; movedFrom?: { id: string; project: string } }> {
  const cwd = opts.cwd ?? process.cwd();
  if (opts.ticket) {
    const target = await resolveTicketTarget(opts.ticket, {
      project: opts.project,
      cwd,
    });
    return { ticketDir: target.ticketDir, movedFrom: target.movedFrom };
  }
  const { initSessionDb } = await import('../dashboard/session-db.js');
  initSessionDb();
  const se = await resolveSessionEngagement(cwd);
  if (se) {
    assertMayMutate(se.session, { hasSelector: false });
  }
  const target = await resolveTicketTarget(undefined, {
    project: opts.project,
    cwd,
    resolveEngagement: async () => se?.open ?? null,
  });
  return { ticketDir: target.ticketDir, movedFrom: target.movedFrom };
}

export interface ShowCommandOptions {
  project?: string;
  json?: boolean;
  log?: boolean;
  type?: string;
  dir?: string;
}

export async function runShowCommand(
  ticket: string | undefined,
  options: ShowCommandOptions = {},
): Promise<void> {
  const cwd = options.dir ? options.dir : process.cwd();
  const { ticketDir, movedFrom } = await resolveShowTarget({
    ticket,
    project: options.project,
    cwd,
  });
  const root = syntaurRoot();

  if (movedFrom) {
    const modelPeek = await buildShow(root, ticketDir);
    console.log(
      `Moved: ${movedFrom.id} → ${modelPeek.ticket.id} (project ${modelPeek.ticket.project})`,
    );
  }

  if (options.log) {
    const output = await renderLogOnly(root, ticketDir, options.type);
    console.log(output);
    return;
  }

  const model = await buildShow(root, ticketDir);
  if (options.json) {
    console.log(JSON.stringify(model, null, 2));
    return;
  }

  console.log(renderShowText(model));
}

export const showCommand = new Command('show')
  .description('Render the ticket summary (text, --json, or --log)')
  .argument('[ticket]', 'Ticket id (<PREFIX>-<n>); defaults to session engagement')
  .option('--project <slug>', 'Project slug (required with --project when id is ambiguous)')
  .option('--json', 'Emit the show model as JSON')
  .option('--log', 'Print log entries only (chat notes when the template has no log role)')
  .option('-t, --type <type>', 'Filter log entries by type')
  .action(async (ticket: string | undefined, options: ShowCommandOptions) => {
    await runShowCommand(ticket, options);
  });
