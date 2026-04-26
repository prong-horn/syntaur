import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { updateAssignmentWorkspace } from '../lifecycle/frontmatter.js';
import { writeFileForce } from './fs.js';

export interface CreateWorktreeOptions {
  repository: string;
  branch: string;
  worktreePath: string;
  parentBranch: string;
}

function run(
  command: string,
  args: string[],
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', (err) => {
      resolvePromise({ code: -1, stdout, stderr: stderr + String(err) });
    });
    child.on('close', (code) => {
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

export class GitWorktreeError extends Error {
  constructor(message: string, public readonly stderr: string) {
    super(message);
  }
}

/**
 * Run `git -C <repository> worktree add -b <branch> <worktreePath> <parentBranch>`.
 * Throws GitWorktreeError on non-zero exit, preserving stderr.
 */
export async function createWorktree(opts: CreateWorktreeOptions): Promise<void> {
  const { repository, branch, worktreePath, parentBranch } = opts;
  const result = await run(
    'git',
    ['-C', repository, 'worktree', 'add', '-b', branch, worktreePath, parentBranch],
  );
  if (result.code !== 0) {
    throw new GitWorktreeError(
      `git worktree add failed (exit ${result.code}): ${result.stderr.trim() || '(no stderr)'}`,
      result.stderr,
    );
  }
}

export async function removeWorktree(
  repository: string,
  worktreePath: string,
): Promise<{ ok: boolean; stderr: string }> {
  const result = await run(
    'git',
    ['-C', repository, 'worktree', 'remove', '--force', worktreePath],
  );
  return { ok: result.code === 0, stderr: result.stderr };
}

export async function deleteBranch(
  repository: string,
  branch: string,
): Promise<{ ok: boolean; stderr: string }> {
  const result = await run('git', ['-C', repository, 'branch', '-D', branch]);
  return { ok: result.code === 0, stderr: result.stderr };
}

export interface CreateWorktreeAndRecordOptions extends CreateWorktreeOptions {
  assignmentPath: string;
}

/**
 * Transactional helper:
 * 1. `git worktree add` — on failure throws, nothing else touched.
 * 2. Read assignment.md, update `workspace.*` fields, write back via writeFileForce.
 * 3. If (2) fails, `git worktree remove --force` to undo step 1. If cleanup fails,
 *    throw an error naming both the file-write error AND the orphan worktree path.
 */
export async function createWorktreeAndRecord(
  opts: CreateWorktreeAndRecordOptions,
): Promise<void> {
  const { assignmentPath, repository, branch, worktreePath, parentBranch } = opts;

  await createWorktree({ repository, branch, worktreePath, parentBranch });

  try {
    const content = await readFile(assignmentPath, 'utf-8');
    const updated = updateAssignmentWorkspace(content, {
      repository,
      worktreePath,
      branch,
      parentBranch,
    });
    await writeFileForce(assignmentPath, updated);
  } catch (writeErr) {
    const cleanup = await removeWorktree(repository, worktreePath);
    // Always try to delete the branch created by -b, even if worktree removal already failed.
    const branchCleanup = await deleteBranch(repository, branch);
    const writeMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
    throw new Error(
      formatRollbackError({
        writeMsg,
        worktreePath,
        branch,
        worktreeCleanup: cleanup,
        branchCleanup,
      }),
    );
  }
}

export function formatRollbackError(opts: {
  writeMsg: string;
  worktreePath: string;
  branch: string;
  worktreeCleanup: { ok: boolean; stderr: string };
  branchCleanup: { ok: boolean; stderr: string };
}): string {
  const { writeMsg, worktreePath, branch, worktreeCleanup, branchCleanup } = opts;
  const wtMsg = worktreeCleanup.stderr.trim() || '(no stderr)';
  const brMsg = branchCleanup.stderr.trim() || '(no stderr)';
  if (!worktreeCleanup.ok && !branchCleanup.ok) {
    return (
      `Failed to update assignment frontmatter AND failed to clean up both worktree and branch. ` +
      `Write error: ${writeMsg}. Worktree cleanup error: ${wtMsg}. Branch cleanup error: ${brMsg}. ` +
      `Orphan worktree at ${worktreePath} and orphan branch "${branch}" — remove them manually.`
    );
  }
  if (!worktreeCleanup.ok) {
    return (
      `Failed to update assignment frontmatter AND failed to clean up worktree. ` +
      `Write error: ${writeMsg}. Worktree cleanup error: ${wtMsg}. ` +
      `Orphan worktree at ${worktreePath} — remove it manually.`
    );
  }
  if (!branchCleanup.ok) {
    return (
      `Failed to update assignment frontmatter: ${writeMsg}. Rolled back git worktree at ${worktreePath}, ` +
      `but could not delete branch "${branch}": ${brMsg}. ` +
      `Remove the branch manually.`
    );
  }
  return `Failed to update assignment frontmatter: ${writeMsg}. Rolled back git worktree at ${worktreePath} and branch "${branch}".`;
}
