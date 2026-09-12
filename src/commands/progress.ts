import { Command } from 'commander';
import { resolve } from 'node:path';
import { fileExists } from '../utils/fs.js';
import { appendProgressLog } from '../lifecycle/progress-append.js';
import { resolveSessionEngagement } from '../utils/engagement-binding.js';
import { resolveTicketTarget } from '../utils/ticket-target.js';
import { assertMayMutate } from '../utils/session-id.js';

async function resolveTicketDir(opts: {
  ticket?: string;
  project?: string;
  cwd: string;
}): Promise<{ dir: string; slug: string }> {
  if (opts.ticket) {
    const target = await resolveTicketTarget(opts.ticket, {
      project: opts.project,
      cwd: opts.cwd,
    });
    return { dir: target.ticketDir, slug: target.ticketSlug };
  }
  // No explicit target → resolve from the session's OPEN engagement and gate
  // the mutation. context.json's ticket scalar is no longer a resolution
  // source (it is a workspace marker only).
  const { initSessionDb } = await import('../dashboard/session-db.js');
  initSessionDb(); // idempotent; no-op if already open
  const se = await resolveSessionEngagement(opts.cwd);
  if (se) {
    assertMayMutate(se.session, { hasSelector: false });
  }
  const target = await resolveTicketTarget(undefined, {
    project: opts.project,
    cwd: opts.cwd,
    resolveEngagement: async () => se?.open ?? null,
  });
  return { dir: target.ticketDir, slug: target.ticketSlug };
}

export async function runProgressLog(
  text: string,
  options: { ticket?: string; project?: string },
  cwd: string = process.cwd(),
): Promise<string> {
  if (!text || text.trim().length === 0) {
    throw new Error('Provide the progress text: `syntaur progress log "<text>"`.');
  }
  const { dir, slug } = await resolveTicketDir({
    ticket: options.ticket,
    project: options.project,
    cwd,
  });
  if (!(await fileExists(resolve(dir, 'ticket.md')))) {
    throw new Error(`No ticket found at ${dir} (missing ticket.md).`);
  }
  const { path } = await appendProgressLog({
    ticketDir: dir,
    ticketRef: slug,
    text,
  });
  return path;
}

export const progressCommand = new Command('progress').description(
  'Record progress on the active ticket',
);

progressCommand
  .command('log')
  .description("Append a timestamped entry to the ticket's progress.md")
  .argument('<text>', 'Progress entry text')
  .option('--ticket <id>', "Ticket id. Defaults to the session's open engagement")
  .option('--project <slug>', 'Project slug. Required with --ticket for a project-nested ticket')
  .action(async (text: string, options: { ticket?: string; project?: string }) => {
    try {
      const path = await runProgressLog(text, options);
      console.log(`Logged progress to ${path}`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
