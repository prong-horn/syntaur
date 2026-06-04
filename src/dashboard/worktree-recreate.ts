import { isExistingDir } from '../launch/cwd.js';
import { recreateWorktree } from '../utils/git-worktree.js';
import { assertRepoRoot, worktreeInFlight } from './api-write.js';
import {
  resolveRecreateTarget,
  type RecreateTargetDeps,
  type RecreateTargetInput,
} from './recreate-target.js';

/**
 * Result of attempting to recreate a deleted worktree for a target. Router-
 * agnostic so both the assignment routes (`api-write.ts`) and the session route
 * (`api-agent-sessions.ts`) map the same outcomes to HTTP without duplicating
 * the resolve → validate → rebuild logic.
 */
export type RecreateOutcome =
  | { status: 'not-found' }
  | { status: 'no-path' }
  | { status: 'no-repo' }
  | { status: 'bad-repo'; httpStatus: number; error: string }
  | { status: 'already-exists'; branch: string | null }
  | { status: 'in-flight' }
  | { status: 'recreated'; baseUsed: string; exact: boolean; branch: string | null };

/**
 * Recreate the worktree for a target, deriving the EXACT path + git inputs from
 * persisted state (assignment frontmatter / session row) — never from a client-
 * supplied path. Bypasses the create-flow's "worktree already configured" /
 * "branch already exists" 409 guards, because recreate intentionally rebuilds at
 * an already-recorded path with a possibly-existing branch.
 */
export async function recreateForTarget(
  deps: RecreateTargetDeps,
  target: RecreateTargetInput,
): Promise<RecreateOutcome> {
  const t = await resolveRecreateTarget(deps, target);
  if (!t) return { status: 'not-found' };
  // An assignment can validly have a repository but no worktree path; that is
  // not a recreate case (nothing recorded to rebuild).
  if (t.worktreePath === '') return { status: 'no-path' };
  // Idempotent: another concurrent click already rebuilt it. The re-fired
  // launch can proceed.
  if (isExistingDir(t.worktreePath)) {
    return { status: 'already-exists', branch: t.branch };
  }
  if (!t.repository) return { status: 'no-repo' };

  const repoCheck = await assertRepoRoot(t.repository);
  if (!repoCheck.ok) {
    return { status: 'bad-repo', httpStatus: repoCheck.status, error: repoCheck.error };
  }

  const key = `recreate:${t.worktreePath}`;
  if (worktreeInFlight.has(key)) return { status: 'in-flight' };
  worktreeInFlight.add(key);
  try {
    const r = await recreateWorktree({
      repository: repoCheck.repo,
      worktreePath: t.worktreePath,
      branch: t.branch,
      originalHeadSha: t.originalHeadSha,
    });
    return { status: 'recreated', baseUsed: r.baseUsed, exact: r.exact, branch: r.branch };
  } finally {
    worktreeInFlight.delete(key);
  }
}

/**
 * Map a RecreateOutcome to an Express-style `{ httpStatus, body }` pair. Shared
 * by every recreate route so the contract is identical across them.
 */
export function recreateOutcomeToHttp(
  outcome: RecreateOutcome,
): { httpStatus: number; body: Record<string, unknown> } {
  switch (outcome.status) {
    case 'not-found':
      return { httpStatus: 404, body: { error: 'Target not found.' } };
    case 'no-path':
      return {
        httpStatus: 422,
        body: { error: 'No recorded worktree path to recreate.' },
      };
    case 'no-repo':
      return {
        httpStatus: 422,
        body: {
          error:
            'Cannot recreate: no repository on record for this worktree.',
        },
      };
    case 'bad-repo':
      return { httpStatus: outcome.httpStatus, body: { error: outcome.error } };
    case 'in-flight':
      return {
        httpStatus: 409,
        body: { error: 'A recreate is already in progress for this worktree.' },
      };
    case 'already-exists':
      return {
        httpStatus: 200,
        body: {
          ok: true,
          alreadyExisted: true,
          baseUsed: outcome.branch ?? 'HEAD',
          exact: true,
          branch: outcome.branch,
        },
      };
    case 'recreated':
      return {
        httpStatus: 200,
        body: {
          ok: true,
          baseUsed: outcome.baseUsed,
          exact: outcome.exact,
          branch: outcome.branch,
        },
      };
  }
}
