import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createWorktreeAndRecord,
  removeWorktree,
  deleteBranch,
  resolveBranchSha,
  listWorktrees,
  isBranchMerged,
  isWorktreeDirty,
  repoTopLevel,
  type WorktreeEntry,
} from '../utils/git-worktree.js';
import { confirmPrompt, isInteractiveTerminal } from '../utils/prompt.js';
import { SyntaurError, formatCliError, exitCodeFor } from '../errors.js';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { assignmentsDir, syntaurRoot } from '../utils/paths.js';
import { readConfig } from '../utils/config.js';
import { listAssignmentsByProject } from '../utils/assignment-walk.js';
import { isTerminalStatus } from '../lifecycle/state-machine.js';
import { canonicalPath } from '../utils/path-canon.js';
import { countSessionsByPath } from '../utils/session-count.js';
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
      const projectsDir = (await readConfig()).defaultProjectDir;
      return resolve(projectsDir, opts.project, 'assignments', opts.assignment, 'assignment.md');
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
  /** Skip the interactive confirm before a --force (destructive) removal. */
  yes?: boolean;
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

  // 1. Git teardown first. On failure, leave the frontmatter untouched. If the
  // worktree dir is already gone (e.g. a prior run removed it but then failed on
  // branch deletion), skip removal so the operation is rerunnable.
  if (await fileExists(worktreePath)) {
    const removed = await removeWorktree(repository, worktreePath, { force: options.force });
    if (!removed.ok) {
      throw new Error(
        `git worktree remove failed: ${removed.stderr.trim() || '(no stderr)'}` +
          (options.force ? '' : '\nThe worktree may be dirty or locked — re-run with --force to discard it.'),
      );
    }
  }

  // 2. Optional branch deletion. When --delete-branch was explicitly requested it
  // is part of teardown — a failure means teardown is incomplete, so we abort
  // BEFORE clearing workspace.* (which would otherwise lose the branch reference).
  let branchDeleted = false;
  if (options.deleteBranch && branch) {
    // Print the branch's short SHA first so the user can recover the deleted
    // branch with `git branch <name> <sha>` if they change their mind.
    const sha = await resolveBranchSha(repository, branch);
    if (sha) {
      console.log(
        `Branch "${branch}" was at ${sha}. To recover it: git -C ${repository} branch ${branch} ${sha}`,
      );
    }
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

// --- gc: classify + safely clean up worktrees -------------------------------

export type GcReason =
  | 'removable'
  | 'dirty'
  | 'unmerged'
  | 'non-terminal'
  | 'orphan'
  | 'detached'
  | 'current';

export interface GcCandidate {
  worktreePath: string;
  reason: GcReason;
  assignmentSlug: string | null;
  projectSlug: string | null;
  status: string | null;
  branch: string | null;
  merged: boolean | null;
  dirty: boolean | null;
  sessions: number;
  willRemove: boolean;
}

export interface WorktreeGcOptions {
  repository?: string;
  base?: string;
  apply?: boolean;
  force?: boolean;
  yes?: boolean;
  deleteBranch?: boolean;
  json?: boolean;
}

export interface WorktreeGcResult {
  repository: string;
  base: string;
  candidates: GcCandidate[];
  applied: boolean;
}

interface GcOwner {
  assignmentSlug: string;
  projectSlug: string | null;
  status: string;
  terminal: boolean;
  worktreePathRaw: string;
}

/**
 * Classify every worktree of `repository` and, when `options.apply`, remove the
 * safe ones. A worktree is `removable` only when it is linked to an assignment
 * whose status is terminal (completed/archived), its branch is merged into
 * `base`, and its working tree is clean. `--force` also clears linked+terminal
 * worktrees that are dirty or unmerged. Removal calls `removeWorktree` /
 * `deleteBranch` DIRECTLY and never edits the assignment file, so `workspace.*`
 * is preserved and the worktree stays recoverable via `syntaur open ... --recreate`.
 */
export async function runWorktreeGc(
  options: WorktreeGcOptions,
  cwd: string = process.cwd(),
): Promise<WorktreeGcResult> {
  const repository = options.repository ?? (await repoTopLevel(cwd)) ?? cwd;
  const base = options.base ?? 'main';
  const entries = await listWorktrees(repository);

  // Reverse map: canonical worktree path -> owning assignment(s). A path can be
  // claimed by more than one assignment record; we keep ALL owners so a single
  // completed record can never mask a still-active one (see classification).
  const config = await readConfig();
  const walk = await listAssignmentsByProject(config.defaultProjectDir, assignmentsDir());
  const owners = new Map<string, GcOwner[]>();
  for (const entry of walk.withAssignmentMd) {
    try {
      const content = await readFile(resolve(entry.assignmentDir, 'assignment.md'), 'utf-8');
      const fm = parseAssignmentFrontmatter(content);
      const wp = fm.workspace?.worktreePath;
      if (!wp) continue; // common case: assignment never got a worktree
      const key = canonicalPath(wp);
      const list = owners.get(key) ?? [];
      list.push({
        assignmentSlug: entry.assignmentSlug,
        projectSlug: entry.projectSlug,
        status: fm.status,
        terminal: isTerminalStatus(fm.status) || fm.archived === true,
        worktreePathRaw: wp,
      });
      owners.set(key, list);
    } catch {
      // Unreadable/malformed assignment.md -> skip; never let one abort gc.
    }
  }

  // Never remove the repo's main worktree (always the FIRST entry of
  // `git worktree list`, independent of cwd), the worktree we're standing in, or
  // a bare entry.
  const rt = await repoTopLevel(repository);
  const ct = await repoTopLevel(cwd);
  const repoTop = rt ? canonicalPath(rt) : null;
  const cwdTop = ct ? canonicalPath(ct) : null;
  const mainPath = entries.length > 0 ? canonicalPath(entries[0].worktreePath) : null;
  const dbPath = resolve(syntaurRoot(), 'syntaur.db');

  const candidates: GcCandidate[] = [];
  for (const entry of entries) {
    const canon = canonicalPath(entry.worktreePath);
    const ownerList = owners.get(canon) ?? [];
    const primary = ownerList[0]; // for display
    const linked = ownerList.length > 0;
    // Safe rule: a path is terminal-eligible only if EVERY owning record is
    // terminal. Any non-terminal (active) owner protects the worktree.
    const allTerminal = linked && ownerList.every((o) => o.terminal);

    let reason: GcReason;
    let merged: boolean | null = null;
    let dirty: boolean | null = null;

    const isCurrent =
      entry.bare ||
      (mainPath !== null && canon === mainPath) ||
      (repoTop !== null && canon === repoTop) ||
      (cwdTop !== null && canon === cwdTop);

    if (isCurrent) {
      reason = 'current';
    } else if (entry.detached || entry.branch === null) {
      reason = 'detached';
    } else if (!linked) {
      reason = 'orphan';
    } else if (!allTerminal) {
      reason = 'non-terminal';
    } else {
      dirty = await isWorktreeDirty(entry.worktreePath);
      if (dirty) {
        reason = 'dirty';
      } else {
        merged = await isBranchMerged(repository, entry.branch, base);
        reason = merged ? 'removable' : 'unmerged';
      }
    }

    const sessionPaths = [canon, entry.worktreePath, ...ownerList.map((o) => o.worktreePathRaw)].filter(
      (p): p is string => typeof p === 'string' && p.length > 0,
    );
    const sessions = countSessionsByPath(dbPath, [...new Set(sessionPaths)]);

    const willRemove =
      reason === 'removable' ||
      (Boolean(options.force) && (reason === 'dirty' || reason === 'unmerged'));

    candidates.push({
      worktreePath: entry.worktreePath,
      reason,
      assignmentSlug: primary?.assignmentSlug ?? null,
      projectSlug: primary?.projectSlug ?? null,
      status: primary?.status ?? null,
      branch: entry.branch,
      merged,
      dirty,
      sessions,
      willRemove,
    });
  }

  let applied = false;
  if (options.apply) {
    for (const c of candidates.filter((cand) => cand.willRemove)) {
      if (await fileExists(c.worktreePath)) {
        const removed = await removeWorktree(repository, c.worktreePath, {
          force: Boolean(options.force),
        });
        if (!removed.ok) {
          throw new SyntaurError(
            `git worktree remove failed for ${c.worktreePath}: ${removed.stderr.trim() || '(no stderr)'}`,
            { remediation: 'resolve the git error (dirty/locked?) or re-run with --force' },
          );
        }
      }
      if (options.deleteBranch && c.branch) {
        const sha = await resolveBranchSha(repository, c.branch);
        if (sha) {
          console.log(
            `Branch "${c.branch}" was at ${sha}. To recover it: git -C ${repository} branch ${c.branch} ${sha}`,
          );
        }
        const del = await deleteBranch(repository, c.branch);
        if (!del.ok) {
          throw new SyntaurError(
            `Worktree removed, but deleting branch "${c.branch}" failed: ${del.stderr.trim() || '(no stderr)'}`,
            { remediation: 'delete the branch manually with `git branch -D`' },
          );
        }
      }
      // Deliberately NOT touching the assignment file: workspace.* is preserved
      // so `syntaur open <assignment> --recreate` can rebuild the worktree.
    }
    applied = true;
  }

  return { repository, base, candidates, applied };
}

function printGcReport(result: WorktreeGcResult): void {
  const { candidates, base, applied } = result;
  if (candidates.length === 0) {
    console.log('No worktrees found.');
    return;
  }

  const byReason: Record<GcReason, GcCandidate[]> = {
    removable: [],
    dirty: [],
    unmerged: [],
    'non-terminal': [],
    orphan: [],
    detached: [],
    current: [],
  };
  for (const c of candidates) byReason[c.reason].push(c);

  const label = (c: GcCandidate): string => {
    const who = c.assignmentSlug
      ? `${c.projectSlug ?? '—'}/${c.assignmentSlug}${c.status ? ` (${c.status})` : ''}`
      : '(no assignment)';
    const sess =
      c.sessions > 0
        ? `  [${c.sessions} session${c.sessions === 1 ? '' : 's'} recorded — recoverable via \`syntaur open ${c.assignmentSlug ?? '<assignment>'} --recreate\`]`
        : '';
    return `  ${c.worktreePath}  ${c.branch ?? '(detached)'}  ${who}${sess}`;
  };

  const section = (title: string, reason: GcReason): void => {
    const rows = byReason[reason];
    if (rows.length === 0) return;
    console.log(`\n${title} (${rows.length}):`);
    for (const c of rows) console.log(label(c));
  };

  section(applied ? 'Removed' : `Removable — merged into ${base} + terminal + clean`, 'removable');
  section('Dirty — linked + terminal but uncommitted changes (use --force)', 'dirty');
  section(`Unmerged — linked + terminal but not in ${base} (use --force)`, 'unmerged');
  section('Skipped — assignment not terminal', 'non-terminal');
  section('Skipped — no owning assignment (orphan)', 'orphan');
  section('Skipped — detached / no branch', 'detached');
  section('Skipped — current / main worktree', 'current');

  if (!applied) {
    const n = byReason.removable.length;
    console.log(
      n > 0
        ? `\n${n} worktree${n === 1 ? '' : 's'} removable. Re-run with --apply to remove ${n === 1 ? 'it' : 'them'} — workspace records are preserved (recoverable via \`syntaur open ... --recreate\`).`
        : '\nNothing removable. (Use --force to also clear dirty/unmerged linked+terminal worktrees.)',
    );
  }
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
  .option('--yes', 'Skip the confirmation prompt for a destructive --force removal (required for non-TTY)')
  .action(async (options: WorktreeRemoveOptions) => {
    try {
      // --force discards uncommitted work in the worktree (unrecoverable).
      // Gate it behind a confirm unless --yes; off a TTY, require --yes so we
      // never silently destroy work in a script.
      if (options.force && !options.yes) {
        if (!isInteractiveTerminal()) {
          throw new SyntaurError(
            '--force discards uncommitted work in the worktree, but there is no TTY to confirm.',
            { remediation: 're-run with --yes to confirm the destructive removal' },
          );
        }
        const confirmed = await confirmPrompt(
          '--force will discard any uncommitted work in the worktree. Continue?',
          false,
        );
        if (!confirmed) {
          console.log('Aborted. Nothing was removed.');
          return;
        }
      }
      const { worktreePath, branchDeleted, workspaceCleared } = await runWorktreeRemove(options);
      console.log(`Removed worktree at ${worktreePath}`);
      if (branchDeleted) console.log('Deleted the branch.');
      if (workspaceCleared) console.log('Cleared the assignment workspace fields.');
    } catch (error) {
      // Surface the SyntaurError remediation hint (e.g. "re-run with --yes").
      console.error(formatCliError(error));
      process.exit(exitCodeFor(error));
    }
  });

worktreeCommand
  .command('gc')
  .description(
    "Find worktrees safe to clean up (branch merged into <base> AND linked assignment completed/archived AND clean) and, with --apply, remove them. Dry-run by default. Agent-session history is never deleted — removed worktrees stay recoverable via `syntaur open <assignment> --recreate`. (Uses built-in terminal statuses + the archived flag.)",
  )
  .option('--repository <path>', 'Repository root (defaults to the current worktree)')
  .option('--base <branch>', 'Base branch to test "merged into"', 'main')
  .option('--apply', 'Actually remove the removable worktrees (default is a dry run)')
  .option('--force', 'Also remove linked+terminal worktrees that are dirty or unmerged (destructive)')
  .option('--delete-branch', "Also delete each removed worktree's branch")
  .option('--yes', 'Skip the confirmation prompt for a destructive --apply --force (required for non-TTY)')
  .option('--json', 'Output as JSON')
  .action(async (options: WorktreeGcOptions) => {
    try {
      // --apply --force can discard uncommitted work (dirty) or unmerged branches.
      // Gate it behind a confirm unless --yes; off a TTY, require --yes.
      if (options.apply && options.force && !options.yes) {
        if (!isInteractiveTerminal()) {
          throw new SyntaurError(
            '--apply --force can discard dirty/unmerged worktrees, but there is no TTY to confirm.',
            { remediation: 're-run with --yes to confirm the destructive removal' },
          );
        }
        const confirmed = await confirmPrompt(
          '--force will also remove dirty/unmerged worktrees (discarding any uncommitted work). Continue?',
          false,
        );
        if (!confirmed) {
          console.log('Aborted. Nothing was removed.');
          return;
        }
      }
      const result = await runWorktreeGc(options);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printGcReport(result);
    } catch (error) {
      console.error(formatCliError(error));
      process.exit(exitCodeFor(error));
    }
  });

export const _internal = {
  resolveAssignmentPath,
  readContext,
};
