import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/**
 * Resolving a ticket's workspace directory. Neutral by design: the chat
 * broker, worktree recreation, the session commands and the git-worktree helper
 * all need it, so it lives under `src/utils/` rather than inside any one
 * feature.
 */

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
  worktree: string | null;
  repository: string | null;
  branch: string | null;
  ticketSlug: string;
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
 * Resolve the working directory for a ticket, preferring a validated
 * `worktree`, then a validated `repository`. NEVER returns `process.cwd()`:
 * when neither is an existing directory, returns `{ cwd: null, invalidReason }`
 * so the caller decides whether to fail or fall back to its own path.
 */
export function resolveWorkspaceCwd(
  input: WorkspaceCwdInput,
): WorkspaceCwdResult {
  const { worktree, repository, branch, ticketSlug } = input;

  if (isExistingDir(worktree)) {
    return { cwd: worktree, fallbackWarning: null, invalidReason: null };
  }

  if (isExistingDir(repository)) {
    const fallbackWarning = worktree
      ? `syntaur: workspace.worktree ${worktree} is not an existing directory for ${ticketSlug} — launching in ${repository}`
      : formatFallbackCwdWarning({
          ticketSlug,
          workspaceDir: repository as string,
          worktree,
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
      `workspace path invalid for ${ticketSlug}: tried worktree ` +
      `${shown(worktree)} and repository ${shown(repository)} — ` +
      `neither is an existing directory`,
  };
}

/**
 * Build the one-line warning emitted when a caller falls back to a cwd because
 * the ticket is missing `workspace.worktree` and/or `workspace.branch`.
 * Returns null when both fields are populated (no warning needed).
 */
export function formatFallbackCwdWarning(opts: {
  ticketSlug: string;
  workspaceDir: string;
  worktree: string | null;
  branch: string | null;
}): string | null {
  const missing: string[] = [];
  if (!opts.worktree) missing.push('worktree');
  if (!opts.branch) missing.push('branch');
  if (missing.length === 0) return null;
  const fields = missing.map((m) => `workspace.${m}`).join(' and ');
  return `syntaur: ${fields} not set for ${opts.ticketSlug} — launching in ${opts.workspaceDir}`;
}
