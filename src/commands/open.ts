import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileExists } from '../utils/fs.js';
import { SyntaurError, formatCliError, exitCodeFor } from '../errors.js';
import { confirmPrompt, isInteractiveTerminal } from '../utils/prompt.js';
import { resolveTicketTarget } from '../utils/ticket-target.js';
import { resolveEngagementBinding } from '../utils/engagement-binding.js';
import { parseTicketFrontmatter } from '../lifecycle/frontmatter.js';
import { readConfig } from '../utils/config.js';
import { defaultProjectDir } from '../utils/paths.js';
import { recreateForTarget, recreateOutcomeToHttp } from '../dashboard/worktree-recreate.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { openInEditor, openInTerminal } from '../utils/open-launch.js';

interface OpenOptions {
  id?: string;
  project?: string;
  editor?: boolean;
  terminal?: boolean;
  recreate?: boolean;
  json?: boolean;
  cwd?: string;
}

export async function runOpen(
  ticketArg: string | undefined,
  options: OpenOptions,
): Promise<{ worktree: string; recreated: boolean; copied: boolean; launched: 'editor' | 'terminal' | null }> {
  // A UUID (--id) is globally unique, so it must resolve WITHOUT a project
  // narrow (the resolver's project branch would otherwise treat it as a slug
  // under that project). --project only applies to a positional slug.
  const cwd = options.cwd ?? process.cwd();
  const resolved = options.id
    ? await resolveTicketTarget(options.id, { cwd, resolveEngagement: () => resolveEngagementBinding(cwd) })
    : await resolveTicketTarget(ticketArg, {
        project: options.project,
        cwd,
        resolveEngagement: () => resolveEngagementBinding(cwd),
      });
  const ticketPath = resolve(resolved.ticketDir, 'ticket.md');
  if (!(await fileExists(ticketPath))) {
    throw new SyntaurError(`Ticket file not found: ${ticketPath}`, {
      remediation: 'check the ticket slug or --id',
    });
  }
  const fm = parseTicketFrontmatter(await readFile(ticketPath, 'utf-8'));
  const worktree = fm.workspace?.worktree;
  if (!worktree) {
    throw new SyntaurError('No worktree recorded for this ticket.', {
      remediation: 'create one with `syntaur worktree create`',
    });
  }

  // If the directory is gone (e.g. cleaned up by `worktree gc`), recover it.
  let recreated = false;
  if (!(await fileExists(worktree))) {
    const allowRecreate =
      Boolean(options.recreate) ||
      (isInteractiveTerminal() &&
        (await confirmPrompt(`Worktree dir is missing (${worktree}). Recreate it now?`, true)));
    if (!allowRecreate) {
      throw new SyntaurError(`Worktree directory is missing: ${worktree}`, {
        remediation: 're-run with --recreate to rebuild it at the recorded path',
      });
    }
    const config = await readConfig();
    const outcome = await recreateForTarget(
      {
        projectsDir: config.defaultProjectDir || defaultProjectDir(),
      },
      { kind: 'ticket', id: resolved.id },
    );
    const mapped = recreateOutcomeToHttp(outcome);
    if (mapped.httpStatus >= 400) {
      throw new SyntaurError(
        typeof mapped.body.error === 'string' ? mapped.body.error : `Recreate failed (${outcome.status})`,
        { remediation: 'check the ticket workspace.repository/branch fields' },
      );
    }
    recreated = outcome.status === 'recreated';
  }

  const copied = copyToClipboard(worktree);
  let launched: 'editor' | 'terminal' | null = null;
  if (options.editor) {
    launched = openInEditor(worktree) ? 'editor' : null;
  } else if (options.terminal) {
    launched = openInTerminal(worktree, await readConfig()) ? 'terminal' : null;
  }

  return { worktree, recreated, copied, launched };
}

export const openCommand = new Command('open')
  .description(
    "Resolve a ticket's worktree path — print it and copy it to the clipboard. Optionally open it in your editor/terminal, or recreate the worktree if its directory is missing.",
  )
  .argument('[ticket]', 'Ticket slug (or UUID). Omit to use --id or the session open engagement')
  .option('--id <uuid>', 'Resolve the ticket by its UUID (standalone or project-nested)')
  .option('--project <slug>', 'Project slug (narrows a project-nested ticket slug)')
  .option('--editor', 'Open the worktree in $VISUAL/$EDITOR (or VS Code / macOS open)')
  .option('--terminal', 'Open a terminal at the worktree')
  .option('--recreate', 'If the worktree directory is missing, recreate it at the recorded path')
  .option('--json', 'Output as JSON')
  .action(async (ticketArg: string | undefined, options: OpenOptions) => {
    try {
      const { worktree, recreated, copied, launched } = await runOpen(ticketArg, options);
      if (options.json) {
        console.log(JSON.stringify({ worktree, recreated, copied, launched }, null, 2));
        return;
      }
      console.log(worktree);
      if (recreated) console.log('(recreated the missing worktree)');
      if (copied) console.log('(copied to clipboard)');
      if (launched) console.log(`(opened in ${launched})`);
    } catch (error) {
      console.error(formatCliError(error));
      process.exit(exitCodeFor(error));
    }
  });
