import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { syntaurRoot } from './paths.js';

export interface WorktreeDefaults {
  repository: string;
  branch: string;
  parentBranch: string;
  worktreePath: string;
}

/**
 * Compute branch + worktree-path defaults for an assignment.
 *
 * Branch: `syntaur/<projectSlug>/<assignmentSlug>` when `projectSlug` is
 * non-empty, else `syntaur/<assignmentSlug>` (standalone).
 *
 * Worktree path: `<repository>/.worktrees/<branch>` when a repository is
 * known. Falls back to `~/.syntaur/worktrees/<project|standalone>/<slug>` only
 * when no repository can be detected — keeps callers from producing a path
 * under the wrong tree.
 *
 * `cwd` controls where `detectCurrentGitRoot()` / `detectCurrentBranch()`
 * run. Defaults to the current process cwd (existing CLI/TUI behavior);
 * server-side callers should pass an explicit repo path or `undefined` and
 * resolve the repo via other means before calling.
 */
export function computeWorktreeDefaults(opts: {
  projectSlug: string;
  assignmentSlug: string;
  existing: { repository: string | null; branch: string | null; parentBranch: string | null };
  cwd?: string;
}): Partial<WorktreeDefaults> & { repository?: string } {
  const repository = opts.existing.repository ?? detectCurrentGitRoot(opts.cwd);
  const branch = opts.projectSlug
    ? `syntaur/${opts.projectSlug}/${opts.assignmentSlug}`
    : `syntaur/${opts.assignmentSlug}`;
  const parentBranch = opts.existing.parentBranch ?? detectCurrentBranch(opts.cwd) ?? 'main';
  const worktreeBase = repository
    ? resolve(repository, '.worktrees', branch)
    : resolve(
        syntaurRoot(),
        'worktrees',
        opts.projectSlug || 'standalone',
        opts.assignmentSlug,
      );
  return {
    ...(repository ? { repository } : {}),
    branch,
    parentBranch,
    worktreePath: worktreeBase,
  };
}

function detectCurrentGitRoot(cwd?: string): string | undefined {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf-8',
  });
  if (result.status !== 0) return undefined;
  const out = result.stdout.trim();
  return out.length > 0 ? out : undefined;
}

function detectCurrentBranch(cwd?: string): string | undefined {
  const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd,
    encoding: 'utf-8',
  });
  if (result.status !== 0) return undefined;
  const out = result.stdout.trim();
  if (!out || out === 'HEAD') return undefined;
  return out;
}
