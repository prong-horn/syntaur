import { homedir } from 'node:os';
import { resolveRunner, type AgentConfig } from '../utils/agents-schema.js';
import { expandHome } from '../utils/paths.js';
import { isExistingDir } from '../utils/workspace-cwd.js';

// The neutral half of this module — `isExistingDir`, `resolveWorkspaceCwd` and
// `formatFallbackCwdWarning` — now lives in `src/utils/workspace-cwd.ts`,
// because the chat broker, worktree recreation and the session commands need it
// and none of them are launch code. Re-exported here so the launch modules keep
// one import site.
export {
  formatFallbackCwdWarning,
  isExistingDir,
  resolveWorkspaceCwd,
  type WorkspaceCwdInput,
  type WorkspaceCwdResult,
} from '../utils/workspace-cwd.js';

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

export interface StandaloneCwdResult {
  /** Resolved spawn cwd, or `null` when the agent has no valid standalone cwd. */
  cwd: string | null;
  /** Human-readable reason, set only when `cwd` is `null`. */
  invalidReason: string | null;
}

/**
 * Resolve the spawn cwd for a STANDALONE launch (no assignment, no worktree):
 * - a directory agent (`workdir` set) spawns from its validated `workdir`;
 * - else a claude agent (`resolveRunner === 'claude'`) spawns from the configured
 *   `standaloneDefaultCwd` when it exists, otherwise the user's home directory
 *   (the new standalone-claude capability — a claude agent has no `workdir`);
 * - else (a bare pi/codex with no `workdir`) there is no valid standalone cwd →
 *   `cwd: null` + `invalidReason`, so the caller throws `workspace-path-invalid`
 *   exactly as before (non-regression: a directory agent genuinely needs a dir).
 * Never throws; the caller fails in its own idiom.
 */
export function resolveStandaloneCwd(
  agent: AgentConfig,
  standaloneDefaultCwd: string | null,
): StandaloneCwdResult {
  const wd = agent.workdir?.trim();
  if (wd) {
    const expanded = expandHome(wd);
    if (!isExistingDir(expanded)) {
      return {
        cwd: null,
        invalidReason: `agent "${agent.id}" workdir ${agent.workdir} (resolved ${expanded}) is not an existing directory — a standalone launch requires a valid workdir.`,
      };
    }
    return { cwd: expanded, invalidReason: null };
  }
  if (resolveRunner(agent) === 'claude') {
    const configured = standaloneDefaultCwd?.trim();
    if (configured) {
      const expanded = expandHome(configured);
      if (isExistingDir(expanded)) return { cwd: expanded, invalidReason: null };
      // Configured but invalid → fall back to home rather than hard-failing a
      // claude standalone launch (home is always a sane default).
    }
    return { cwd: homedir(), invalidReason: null };
  }
  return {
    cwd: null,
    invalidReason: `agent "${agent.id}" has no workdir — a standalone launch of a ${resolveRunner(agent)} agent requires a valid workdir.`,
  };
}
