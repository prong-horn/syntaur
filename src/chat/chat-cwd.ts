/**
 * Chat-specific cwd resolution — extends the shared `resolveWorkspaceCwd` with
 * two additional tiers (project repository, home directory) so a chat is NEVER
 * refused for a missing worktree.
 *
 * Other callers of `resolveWorkspaceCwd` (git-worktree, worktree-recreate,
 * session commands) are unchanged: for them a null cwd is the correct result.
 */

import { homedir } from 'node:os';
import { resolveWorkspaceCwd, isExistingDir, type WorkspaceCwdInput } from '../utils/workspace-cwd.js';
import type { CwdTier } from './types.js';

export type { CwdTier };

export interface ChatCwdResult {
  cwd: string;
  tier: CwdTier;
  /** Non-fatal warning carried from the shared resolver or generated here. */
  fallbackWarning: string | null;
}

export interface ResolveChatCwdInput extends WorkspaceCwdInput {
  /** `repositories` from `project.md` frontmatter (may be empty). */
  projectRepositories: string[];
}

/**
 * Resolve the working directory for a chat session. Always succeeds — the
 * chain ends at `os.homedir()`.
 */
export function resolveChatCwd(input: ResolveChatCwdInput): ChatCwdResult {
  const base = resolveWorkspaceCwd(input);

  if (base.cwd) {
    // Determine tier: worktree if it matched worktreePath, else repository.
    const tier: CwdTier = base.cwd === input.worktreePath ? 'worktree' : 'repository';
    return { cwd: base.cwd, tier, fallbackWarning: base.fallbackWarning };
  }

  // Try the project's first repository.
  for (const repo of input.projectRepositories) {
    if (isExistingDir(repo)) {
      return {
        cwd: repo,
        tier: 'project',
        fallbackWarning: `No workspace configured for ${input.assignmentSlug} — launching in project repository ${repo}`,
      };
    }
  }

  // Final fallback: home directory.
  return {
    cwd: homedir(),
    tier: 'home',
    fallbackWarning: `No workspace configured for ${input.assignmentSlug} — launching in home directory`,
  };
}
