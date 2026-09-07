import { Command } from 'commander';
import { resolve } from 'node:path';
import { fileExists } from '../utils/fs.js';
import { assignmentsDir } from '../utils/paths.js';
import { readConfig } from '../utils/config.js';
import { appendProgressLog } from '../lifecycle/progress-append.js';
import { resolveSessionEngagement } from '../utils/engagement-binding.js';
import { resolveAssignmentTarget } from '../utils/assignment-target.js';
import { assertMayMutate } from '../utils/session-id.js';

async function resolveAssignmentDir(opts: {
  assignment?: string;
  project?: string;
  cwd: string;
}): Promise<{ dir: string; slug: string }> {
  if (opts.assignment) {
    if (opts.project) {
      const projectsDir = (await readConfig()).defaultProjectDir;
      return {
        dir: resolve(projectsDir, opts.project, 'assignments', opts.assignment),
        slug: opts.assignment,
      };
    }
    return { dir: resolve(assignmentsDir(), opts.assignment), slug: opts.assignment };
  }
  // No explicit target → resolve from the session's OPEN engagement and gate
  // the mutation. context.json's assignment scalar is no longer a resolution
  // source (it is a workspace marker only).
  const { initSessionDb } = await import('../dashboard/session-db.js');
  initSessionDb(); // idempotent; no-op if already open
  const se = await resolveSessionEngagement(opts.cwd);
  if (se) {
    assertMayMutate(se.session, { hasSelector: false });
  }
  const target = await resolveAssignmentTarget(undefined, {
    project: opts.project,
    cwd: opts.cwd,
    resolveEngagement: async () => se?.open ?? null,
  });
  return { dir: target.assignmentDir, slug: target.assignmentSlug };
}

export async function runProgressLog(
  text: string,
  options: { assignment?: string; project?: string },
  cwd: string = process.cwd(),
): Promise<string> {
  if (!text || text.trim().length === 0) {
    throw new Error('Provide the progress text: `syntaur progress log "<text>"`.');
  }
  const { dir, slug } = await resolveAssignmentDir({
    assignment: options.assignment,
    project: options.project,
    cwd,
  });
  if (!(await fileExists(resolve(dir, 'assignment.md')))) {
    throw new Error(`No assignment found at ${dir} (missing assignment.md).`);
  }
  const { path } = await appendProgressLog({
    assignmentDir: dir,
    assignmentRef: slug,
    text,
  });
  return path;
}

export const progressCommand = new Command('progress').description(
  'Record progress on the active assignment',
);

progressCommand
  .command('log')
  .description("Append a timestamped entry to the assignment's progress.md")
  .argument('<text>', 'Progress entry text')
  .option('--assignment <slug>', "Assignment slug (UUID for standalone). Defaults to the session's open engagement")
  .option('--project <slug>', 'Project slug. Required with --assignment for a project-nested assignment')
  .action(async (text: string, options: { assignment?: string; project?: string }) => {
    try {
      const path = await runProgressLog(text, options);
      console.log(`Logged progress to ${path}`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
