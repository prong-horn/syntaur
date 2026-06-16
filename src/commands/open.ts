import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileExists } from '../utils/fs.js';
import { SyntaurError, formatCliError, exitCodeFor } from '../errors.js';
import { confirmPrompt, isInteractiveTerminal } from '../utils/prompt.js';
import { resolveAssignmentTarget } from '../utils/assignment-target.js';
import { parseAssignmentFrontmatter } from '../lifecycle/frontmatter.js';
import { readConfig } from '../utils/config.js';
import { assignmentsDir, defaultProjectDir } from '../utils/paths.js';
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
}

export async function runOpen(
  assignmentArg: string | undefined,
  options: OpenOptions,
): Promise<{ worktreePath: string; recreated: boolean; copied: boolean; launched: 'editor' | 'terminal' | null }> {
  // A UUID (--id) is globally unique, so it must resolve WITHOUT a project
  // narrow (the resolver's project branch would otherwise treat it as a slug
  // under that project). --project only applies to a positional slug.
  const resolved = options.id
    ? await resolveAssignmentTarget(options.id, {})
    : await resolveAssignmentTarget(assignmentArg, { project: options.project });
  const assignmentPath = resolve(resolved.assignmentDir, 'assignment.md');
  if (!(await fileExists(assignmentPath))) {
    throw new SyntaurError(`Assignment file not found: ${assignmentPath}`, {
      remediation: 'check the assignment slug or --id',
    });
  }
  const fm = parseAssignmentFrontmatter(await readFile(assignmentPath, 'utf-8'));
  const worktreePath = fm.workspace?.worktreePath;
  if (!worktreePath) {
    throw new SyntaurError('No worktree recorded for this assignment.', {
      remediation: 'create one with `syntaur worktree create`',
    });
  }

  // If the directory is gone (e.g. cleaned up by `worktree gc`), recover it.
  let recreated = false;
  if (!(await fileExists(worktreePath))) {
    const allowRecreate =
      Boolean(options.recreate) ||
      (isInteractiveTerminal() &&
        (await confirmPrompt(`Worktree dir is missing (${worktreePath}). Recreate it now?`, true)));
    if (!allowRecreate) {
      throw new SyntaurError(`Worktree directory is missing: ${worktreePath}`, {
        remediation: 're-run with --recreate to rebuild it at the recorded path',
      });
    }
    const config = await readConfig();
    const outcome = await recreateForTarget(
      {
        projectsDir: config.defaultProjectDir || defaultProjectDir(),
        assignmentsDir: assignmentsDir(),
      },
      { kind: 'assignment', id: resolved.id },
    );
    const mapped = recreateOutcomeToHttp(outcome);
    if (mapped.httpStatus >= 400) {
      throw new SyntaurError(
        typeof mapped.body.error === 'string' ? mapped.body.error : `Recreate failed (${outcome.status})`,
        { remediation: 'check the assignment workspace.repository/branch fields' },
      );
    }
    recreated = outcome.status === 'recreated';
  }

  const copied = copyToClipboard(worktreePath);
  let launched: 'editor' | 'terminal' | null = null;
  if (options.editor) {
    launched = openInEditor(worktreePath) ? 'editor' : null;
  } else if (options.terminal) {
    launched = openInTerminal(worktreePath, await readConfig()) ? 'terminal' : null;
  }

  return { worktreePath, recreated, copied, launched };
}

export const openCommand = new Command('open')
  .description(
    "Resolve an assignment's worktree path — print it and copy it to the clipboard. Optionally open it in your editor/terminal, or recreate the worktree if its directory is missing.",
  )
  .argument('[assignment]', 'Assignment slug (or UUID). Omit to use --id or the active .syntaur/context.json')
  .option('--id <uuid>', 'Resolve the assignment by its UUID (standalone or project-nested)')
  .option('--project <slug>', 'Project slug (narrows a project-nested assignment slug)')
  .option('--editor', 'Open the worktree in $VISUAL/$EDITOR (or VS Code / macOS open)')
  .option('--terminal', 'Open a terminal at the worktree')
  .option('--recreate', 'If the worktree directory is missing, recreate it at the recorded path')
  .option('--json', 'Output as JSON')
  .action(async (assignmentArg: string | undefined, options: OpenOptions) => {
    try {
      const { worktreePath, recreated, copied, launched } = await runOpen(assignmentArg, options);
      if (options.json) {
        console.log(JSON.stringify({ worktreePath, recreated, copied, launched }, null, 2));
        return;
      }
      console.log(worktreePath);
      if (recreated) console.log('(recreated the missing worktree)');
      if (copied) console.log('(copied to clipboard)');
      if (launched) console.log(`(opened in ${launched})`);
    } catch (error) {
      console.error(formatCliError(error));
      process.exit(exitCodeFor(error));
    }
  });
