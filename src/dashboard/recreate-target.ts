import { getTicketDetail, getTicketDetailById } from './api.js';
import { getSessionById } from './agent-sessions.js';
import { isExistingDir } from '../utils/workspace-cwd.js';

/**
 * Identifies a thing whose deleted worktree may need recreating. Assignments
 * arrive either by UUID (preflight + the standalone route) or by project+slug
 * (the project-nested route, whose params are only `:slug/:aslug` — never the
 * UUID). Sessions always arrive by session id.
 */
export type RecreateTargetInput =
  | { kind: 'assignment'; id: string }
  | { kind: 'assignment'; projectSlug: string; ticketSlug: string }
  | { kind: 'session'; id: string };

export interface RecreateTargetDeps {
  projectsDir: string;
  ticketsDir: string;
}

/**
 * Fully-resolved recreate target: the EXACT path to rebuild plus the git inputs
 * needed to do it, derived server-side from persisted state (assignment
 * frontmatter / session row) — never from a client-supplied path.
 */
export interface RecreateTarget {
  kind: 'assignment' | 'session';
  id: string;
  projectSlug: string | null;
  ticketSlug: string | null;
  /** Exact recorded worktree path; '' when nothing is on record. */
  worktreePath: string;
  repository: string | null;
  branch: string | null;
  originalHeadSha: string | null;
  /** A path is recorded but the directory is gone. */
  missing: boolean;
  /** Missing AND we have enough (a repository) to auto-recreate it. */
  recreatable: boolean;
}

/**
 * Single source of truth shared by launch preflight (to decide whether to show
 * the recreate popup) and the recreate endpoints (to perform the rebuild), so
 * the popup and the action can never disagree. Returns `null` when the
 * assignment/session itself cannot be found.
 */
export async function resolveRecreateTarget(
  deps: RecreateTargetDeps,
  target: RecreateTargetInput,
): Promise<RecreateTarget | null> {
  const { projectsDir, ticketsDir } = deps;

  if (target.kind === 'assignment') {
    const detail =
      'id' in target
        ? await getTicketDetailById(projectsDir, ticketsDir, target.id)
        : await getTicketDetail(
            projectsDir,
            target.projectSlug,
            target.ticketSlug,
          );
    if (!detail) return null;
    const worktreePath = detail.workspace.worktreePath ?? '';
    const repository = detail.workspace.repository ?? null;
    const branch = detail.workspace.branch ?? null;
    const missing = worktreePath !== '' && !isExistingDir(worktreePath);
    return {
      kind: 'assignment',
      id: detail.id,
      projectSlug: detail.projectSlug ?? null,
      ticketSlug: detail.slug,
      worktreePath,
      repository,
      branch,
      originalHeadSha: null,
      missing,
      recreatable: missing && isExistingDir(repository),
    };
  }

  // Session: the recorded `session.path` is the only cwd under which the
  // transcript is indexed, so it is the authoritative path to rebuild. The git
  // inputs (repository/branch) come from the linked assignment.
  const session = getSessionById(target.id);
  if (!session) return null;

  let repository: string | null = null;
  let branch: string | null = null;
  let assignmentWorktreePath = '';
  if (session.projectSlug && session.ticketSlug) {
    const detail = await getTicketDetail(
      projectsDir,
      session.projectSlug,
      session.ticketSlug,
    );
    if (detail) {
      repository = detail.workspace.repository ?? null;
      branch = detail.workspace.branch ?? null;
      assignmentWorktreePath = detail.workspace.worktreePath ?? '';
    }
  } else if (session.ticketSlug) {
    // Standalone session: `project_slug IS NULL` and `assignment_slug` holds the
    // assignment UUID (see listSessionsByTicket), so resolve it by id.
    const detail = await getTicketDetailById(
      projectsDir,
      ticketsDir,
      session.ticketSlug,
    );
    if (detail) {
      repository = detail.workspace.repository ?? null;
      branch = detail.workspace.branch ?? null;
      assignmentWorktreePath = detail.workspace.worktreePath ?? '';
    }
  }

  const worktreePath = session.path || assignmentWorktreePath;
  const missing = worktreePath !== '' && !isExistingDir(worktreePath);
  return {
    kind: 'session',
    id: session.sessionId,
    projectSlug: session.projectSlug ?? null,
    ticketSlug: session.ticketSlug ?? null,
    worktreePath,
    repository,
    branch,
    originalHeadSha: session.originalHeadSha ?? null,
    missing,
    recreatable: missing && isExistingDir(repository),
  };
}
