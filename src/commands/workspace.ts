import { Command } from 'commander';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileExists } from '../utils/fs.js';
import { defaultProjectDir, assignmentsDir } from '../utils/paths.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { updateAssignmentWorkspace, updateAssignmentFile } from '../lifecycle/frontmatter.js';
import { validateAssignmentFile } from './doctor.js';

interface ContextFile {
  assignmentDir?: string;
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
      return resolve(defaultProjectDir(), opts.project, 'assignments', opts.assignment, 'assignment.md');
    }
    return resolve(assignmentsDir(), opts.assignment, 'assignment.md');
  }
  const ctx = await readContext(opts.cwd);
  if (ctx?.assignmentDir) return resolve(ctx.assignmentDir, 'assignment.md');
  throw new Error(
    'No active assignment. Pass --assignment <slug> [--project <slug>] or run from a workspace with .syntaur/context.json.',
  );
}

export interface WorkspaceSetOptions {
  repository?: string;
  worktreePath?: string;
  branch?: string;
  parentBranch?: string;
  assignment?: string;
  project?: string;
}

export async function runWorkspaceSet(
  options: WorkspaceSetOptions,
  cwd: string = process.cwd(),
): Promise<{ path: string; fields: Record<string, string | null> }> {
  const partial: Record<'repository' | 'worktreePath' | 'branch' | 'parentBranch', string> = {} as never;
  const fields: Record<string, string | null> = {};
  let any = false;
  for (const key of ['repository', 'worktreePath', 'branch', 'parentBranch'] as const) {
    const value = options[key];
    if (value !== undefined) {
      (partial as Record<string, string>)[key] = value;
      fields[key] = value;
      any = true;
    }
  }
  if (!any) {
    throw new Error(
      'Provide at least one of --repository, --worktree-path, --branch, --parent-branch.',
    );
  }

  const path = await resolveAssignmentPath({
    assignment: options.assignment,
    project: options.project,
    cwd,
  });
  if (!(await fileExists(path))) {
    throw new Error(`Assignment file not found: ${path}`);
  }

  // Pre-write validation — refuse to touch a malformed assignment.
  const pre = await validateAssignmentFile(path);
  if (!pre.ok) {
    throw new Error(
      `Refusing to write — assignment.md is invalid:\n${pre.errors.map((e) => `  - ${e}`).join('\n')}`,
    );
  }

  const original = await readFile(path, 'utf-8');
  let next = updateAssignmentWorkspace(original, partial);
  next = updateAssignmentFile(next, { updated: nowTimestamp() });
  await writeFile(path, next, 'utf-8');

  // Post-write validation — restore the original if we somehow broke it.
  const post = await validateAssignmentFile(path);
  if (!post.ok) {
    await writeFile(path, original, 'utf-8');
    throw new Error(
      `Write rolled back — post-write validation failed:\n${post.errors.map((e) => `  - ${e}`).join('\n')}`,
    );
  }

  return { path, fields };
}

export const workspaceCommand = new Command('workspace').description(
  'Manage the active assignment workspace binding',
);

workspaceCommand
  .command('set')
  .description('Set the four workspace.* frontmatter fields atomically (validates + bumps updated)')
  .option('--repository <path>', 'Repository root')
  .option('--worktree-path <path>', 'Worktree path (typically <repo>/.worktrees/<branch>)')
  .option('--branch <name>', 'Branch name')
  .option('--parent-branch <name>', 'Parent branch (typically main)')
  .option('--assignment <slug>', 'Assignment slug (UUID for standalone). Defaults to .syntaur/context.json')
  .option('--project <slug>', 'Project slug. Required with --assignment for a project-nested assignment')
  .action(async (options: WorkspaceSetOptions) => {
    try {
      const { path, fields } = await runWorkspaceSet(options);
      console.log(`Updated workspace in ${path}`);
      for (const [k, v] of Object.entries(fields)) {
        console.log(`  ${k}: ${v ?? 'null'}`);
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
