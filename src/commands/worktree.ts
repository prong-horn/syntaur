import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createWorktreeAndRecord } from '../utils/git-worktree.js';
import { fileExists } from '../utils/fs.js';
import { defaultProjectDir, assignmentsDir } from '../utils/paths.js';

interface ContextFile {
  projectSlug?: string;
  assignmentSlug?: string;
  assignmentDir?: string;
  workspaceRoot?: string;
}

async function readContext(cwd: string): Promise<ContextFile | null> {
  const path = resolve(cwd, '.syntaur', 'context.json');
  if (!(await fileExists(path))) return null;
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as ContextFile;
  } catch {
    return null;
  }
}

async function resolveAssignmentPath(opts: {
  assignment?: string;
  project?: string;
  cwd: string;
}): Promise<string> {
  if (opts.assignment) {
    if (opts.project) {
      return resolve(
        defaultProjectDir(),
        opts.project,
        'assignments',
        opts.assignment,
        'assignment.md',
      );
    }
    return resolve(assignmentsDir(), opts.assignment, 'assignment.md');
  }
  const ctx = await readContext(opts.cwd);
  if (ctx?.assignmentDir) return resolve(ctx.assignmentDir, 'assignment.md');
  throw new Error(
    'No active assignment. Pass --assignment <slug> [--project <slug>] or run from a workspace with .syntaur/context.json.',
  );
}

interface WorktreeCreateOptions {
  repository?: string;
  branch: string;
  parentBranch?: string;
  assignment?: string;
  project?: string;
  worktreePath?: string;
}

export async function runWorktreeCreate(
  options: WorktreeCreateOptions,
  cwd: string = process.cwd(),
): Promise<{ worktreePath: string; assignmentPath: string }> {
  if (!options.branch) {
    throw new Error('--branch is required.');
  }
  const repository = options.repository ?? cwd;
  const parentBranch = options.parentBranch ?? 'main';
  // Repo-local convention per assignment: <repo>/.worktrees/<branch>
  const worktreePath =
    options.worktreePath ?? resolve(repository, '.worktrees', options.branch);

  const assignmentPath = await resolveAssignmentPath({
    assignment: options.assignment,
    project: options.project,
    cwd,
  });
  if (!(await fileExists(assignmentPath))) {
    throw new Error(`Assignment file not found: ${assignmentPath}`);
  }

  await createWorktreeAndRecord({
    repository,
    branch: options.branch,
    worktreePath,
    parentBranch,
    assignmentPath,
  });

  return { worktreePath, assignmentPath };
}

export const worktreeCommand = new Command('worktree')
  .description('Manage git worktrees bound to Syntaur assignments');

worktreeCommand
  .command('create')
  .description(
    'Create a worktree at <repository>/.worktrees/<branch> and record it in the assignment workspace block. Atomic — rolls back the worktree if writing assignment.md fails.',
  )
  .requiredOption('--branch <name>', 'Branch name to create (also used as worktree dir name)')
  .option('--repository <path>', 'Repository root (defaults to current working directory)')
  .option('--parent-branch <name>', 'Parent branch to fork from', 'main')
  .option('--assignment <slug>', 'Assignment slug (UUID for standalone). Defaults to .syntaur/context.json')
  .option('--project <slug>', 'Project slug. Required when --assignment is given for a project-nested assignment')
  .option('--worktree-path <path>', 'Override the computed <repository>/.worktrees/<branch> path')
  .action(async (options: WorktreeCreateOptions) => {
    try {
      const { worktreePath, assignmentPath } = await runWorktreeCreate(options);
      console.log(`Created worktree at ${worktreePath}`);
      console.log(`Recorded workspace fields in ${assignmentPath}`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

export const _internal = {
  resolveAssignmentPath,
  readContext,
};
