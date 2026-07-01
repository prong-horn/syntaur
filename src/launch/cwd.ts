import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { AgentConfig } from '../utils/agents-schema.js';
import { expandHome } from '../utils/paths.js';

/**
 * True only for an absolute path that exists and is a directory. Wraps the
 * `statSync` call so a race (deleted between `existsSync` and `statSync`) or a
 * permission error resolves to `false` rather than throwing.
 */
export function isExistingDir(p: string | null | undefined): boolean {
  if (!p || !isAbsolute(p)) return false;
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export interface WorkspaceCwdInput {
  worktreePath: string | null;
  repository: string | null;
  branch: string | null;
  assignmentSlug: string;
}

export interface WorkspaceCwdResult {
  /** Resolved, validated working directory, or `null` when none is valid. */
  cwd: string | null;
  /** Non-fatal warning when falling back from a missing/invalid worktree. */
  fallbackWarning: string | null;
  /** Human-readable reason, set only when `cwd` is `null`. */
  invalidReason: string | null;
}

/**
 * Resolve the working directory for a launch, preferring a validated
 * `worktreePath`, then a validated `repository`. NEVER returns `process.cwd()`:
 * when neither is an existing directory, returns `{ cwd: null, invalidReason }`
 * so the caller decides whether to fail (assignment launches) or fall back to
 * its own path (session launches keep `session.path`).
 */
export function resolveWorkspaceCwd(
  input: WorkspaceCwdInput,
): WorkspaceCwdResult {
  const { worktreePath, repository, branch, assignmentSlug } = input;

  if (isExistingDir(worktreePath)) {
    return { cwd: worktreePath, fallbackWarning: null, invalidReason: null };
  }

  if (isExistingDir(repository)) {
    // A present-but-invalid worktreePath gets a dedicated warning; a missing
    // worktreePath reuses the standard missing-field warning so existing
    // behavior (and its tests) are preserved.
    const fallbackWarning = worktreePath
      ? `syntaur: workspace.worktreePath ${worktreePath} is not an existing directory for ${assignmentSlug} — launching in ${repository}`
      : formatFallbackCwdWarning({
          assignmentSlug,
          workspaceDir: repository as string,
          worktreePath,
          branch,
        });
    return { cwd: repository, fallbackWarning, invalidReason: null };
  }

  const shown = (p: string | null): string =>
    p && p.trim().length > 0 ? p : '(unset)';
  return {
    cwd: null,
    fallbackWarning: null,
    invalidReason:
      `workspace path invalid for ${assignmentSlug}: tried worktreePath ` +
      `${shown(worktreePath)} and repository ${shown(repository)} — ` +
      `neither is an existing directory`,
  };
}

export interface LaunchCwdResult {
  /** Directory the agent process is spawned from. */
  spawnCwd: string;
  /**
   * The assignment's worktree. Equals `spawnCwd` for a normal launch; for a
   * directory-agent (`workdir`) it stays the worktree while `spawnCwd` moves to
   * the agent dir. This is where context.json belongs and what `@worktree`
   * resolves to — never the agent's `workdir`.
   */
  worktreePath: string;
  /** Set only when a configured `workdir` does not resolve to a directory. */
  invalidReason: string | null;
}

/**
 * Resolve the spawn cwd for an agent against the assignment's already-resolved
 * worktree cwd. A directory-agent (`agent.workdir` set) is spawned from its own
 * directory (after `~` expansion + existence check) while the worktree path is
 * preserved separately for context.json and `@worktree`. Any other agent spawns
 * from the worktree. Never throws: an invalid `workdir` is reported via
 * `invalidReason` so each caller can fail in its own idiom.
 */
export function resolveLaunchCwd(
  agent: AgentConfig,
  worktreeCwd: string,
): LaunchCwdResult {
  const wd = agent.workdir?.trim();
  if (wd) {
    const expanded = expandHome(wd);
    if (!isExistingDir(expanded)) {
      return {
        spawnCwd: worktreeCwd,
        worktreePath: worktreeCwd,
        invalidReason: `agent "${agent.id}" workdir ${agent.workdir} (resolved ${expanded}) is not an existing directory`,
      };
    }
    return { spawnCwd: expanded, worktreePath: worktreeCwd, invalidReason: null };
  }
  return { spawnCwd: worktreeCwd, worktreePath: worktreeCwd, invalidReason: null };
}

/**
 * Build the one-line warning emitted when a launch falls back to a cwd because
 * the assignment is missing `workspace.worktreePath` and/or `workspace.branch`.
 * Returns null when both fields are populated (no warning needed).
 */
export function formatFallbackCwdWarning(opts: {
  assignmentSlug: string;
  workspaceDir: string;
  worktreePath: string | null;
  branch: string | null;
}): string | null {
  const missing: string[] = [];
  if (!opts.worktreePath) missing.push('worktreePath');
  if (!opts.branch) missing.push('branch');
  if (missing.length === 0) return null;
  const fields = missing.map((m) => `workspace.${m}`).join(' and ');
  return `syntaur: ${fields} not set for ${opts.assignmentSlug} — launching in ${opts.workspaceDir}`;
}
