import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createWorktreeAndRecord,
  removeWorktree,
  deleteBranch,
  listWorktrees,
  type WorktreeEntry,
} from '../utils/git-worktree.js';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { defaultProjectDir, assignmentsDir } from '../utils/paths.js';
import { nowTimestamp } from '../utils/timestamp.js';
import {
  parseAssignmentFrontmatter,
  updateAssignmentWorkspace,
  updateAssignmentFile,
} from '../lifecycle/frontmatter.js';

interface ContextFile {
  projectSlug?: string;
  assignmentSlug?: string;
  assignmentDir?: string;
  workspaceRoot?: string;
  // Bundle-scoped fields (this reader only cares about assignmentDir; the
  // bundle fields are tolerated so the file parses cleanly inside a bundle worktree).
  bundleId?: string;
  bundleSlug?: string;
  bundleScope?: string;
  bundleScopeId?: string;
  todoIds?: string[];
  planDir?: string;
  branch?: string;
  worktreePath?: string;
  repository?: string;
  boundAt?: string;
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

export async function runWorktreeList(
  repository: string = process.cwd(),
): Promise<WorktreeEntry[]> {
  return listWorktrees(repository);
}

export interface WorktreeRemoveOptions {
  assignment?: string;
  project?: string;
  repository?: string;
  deleteBranch?: boolean;
  force?: boolean;
}

export async function runWorktreeRemove(
  options: WorktreeRemoveOptions,
  cwd: string = process.cwd(),
): Promise<{ worktreePath: string; branchDeleted: boolean; workspaceCleared: boolean }> {
  const assignmentPath = await resolveAssignmentPath({
    assignment: options.assignment,
    project: options.project,
    cwd,
  });
  if (!(await fileExists(assignmentPath))) {
    throw new Error(`Assignment file not found: ${assignmentPath}`);
  }
  const original = await readFile(assignmentPath, 'utf-8');
  const fm = parseAssignmentFrontmatter(original);
  const repository = options.repository ?? fm.workspace.repository ?? undefined;
  const worktreePath = fm.workspace.worktreePath ?? undefined;
  const branch = fm.workspace.branch ?? undefined;

  if (!repository) {
    throw new Error(
      'No repository recorded in the assignment workspace. Pass --repository <path>.',
    );
  }
  if (!worktreePath) {
    throw new Error('No worktreePath recorded in the assignment workspace — nothing to remove.');
  }

  // 1. Git teardown first. On failure, leave the frontmatter untouched.
  const removed = await removeWorktree(repository, worktreePath, { force: options.force });
  if (!removed.ok) {
    throw new Error(
      `git worktree remove failed: ${removed.stderr.trim() || '(no stderr)'}` +
        (options.force ? '' : '\nThe worktree may be dirty or locked — re-run with --force to discard it.'),
    );
  }

  // 2. Optional branch deletion. When --delete-branch was explicitly requested it
  // is part of teardown — a failure means teardown is incomplete, so we abort
  // BEFORE clearing workspace.* (which would otherwise lose the branch reference).
  let branchDeleted = false;
  if (options.deleteBranch && branch) {
    const del = await deleteBranch(repository, branch);
    if (!del.ok) {
      throw new Error(
        `Worktree removed, but deleting branch "${branch}" failed: ${del.stderr.trim() || '(no stderr)'}. ` +
          'Workspace fields were left intact. Delete the branch manually, then re-run to clear them.',
      );
    }
    branchDeleted = true;
  }

  // 3. Clear the four workspace.* fields + bump updated. If this fails after the
  // git teardown, report it — a re-run is idempotent (worktree already gone).
  let workspaceCleared = false;
  try {
    let next = updateAssignmentWorkspace(original, {
      repository: null,
      worktreePath: null,
      branch: null,
      parentBranch: null,
    });
    next = updateAssignmentFile(next, { updated: nowTimestamp() });
    await writeFileForce(assignmentPath, next);
    workspaceCleared = true;
  } catch (err) {
    console.error(
      `Warning: worktree removed but failed to clear workspace fields in ${assignmentPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return { worktreePath, branchDeleted, workspaceCleared };
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

worktreeCommand
  .command('list')
  .description('List the git worktrees of a repository')
  .option('--repository <path>', 'Repository root (defaults to current working directory)')
  .option('--json', 'Output as JSON')
  .action(async (options: { repository?: string; json?: boolean }) => {
    try {
      const entries = await runWorktreeList(options.repository ?? process.cwd());
      if (options.json) {
        console.log(JSON.stringify(entries, null, 2));
      } else if (entries.length === 0) {
        console.log('No worktrees.');
      } else {
        for (const e of entries) {
          const ref = e.detached ? '(detached)' : e.branch ?? '(no branch)';
          console.log(`${e.worktreePath}  ${ref}`);
        }
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

worktreeCommand
  .command('remove')
  .alias('prune')
  .description(
    "Remove an assignment's git worktree and clear its workspace.* fields. Branch deletion is opt-in.",
  )
  .option('--assignment <slug>', 'Assignment slug (UUID for standalone). Defaults to .syntaur/context.json')
  .option('--project <slug>', 'Project slug. Required when --assignment is given for a project-nested assignment')
  .option('--repository <path>', 'Repository root (defaults to the recorded workspace.repository)')
  .option('--delete-branch', 'Also delete the branch after removing the worktree')
  .option('--force', 'Discard a dirty/locked worktree (passes --force to git)')
  .action(async (options: WorktreeRemoveOptions) => {
    try {
      const { worktreePath, branchDeleted, workspaceCleared } = await runWorktreeRemove(options);
      console.log(`Removed worktree at ${worktreePath}`);
      if (branchDeleted) console.log('Deleted the branch.');
      if (workspaceCleared) console.log('Cleared the assignment workspace fields.');
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

export const _internal = {
  resolveAssignmentPath,
  readContext,
};
