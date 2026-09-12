import { getTicketDetail, getTicketDetailById } from './api.js';
import { getSessionById } from './agent-sessions.js';
import { isExistingDir } from '../utils/workspace-cwd.js';

/**
 * Identifies a thing whose deleted worktree may need recreating. Tickets
 * arrive either by UUID (preflight + the standalone route) or by project+slug
 * (the project-nested route, whose params are only `:slug/:aslug` — never the
 * UUID). Sessions always arrive by session id.
 */
export type RecreateTargetInput =
  | { kind: 'ticket'; id: string }
  | { kind: 'ticket'; projectSlug: string; ticketSlug: string }
  | { kind: 'session'; id: string };

export interface RecreateTargetDeps {
  projectsDir: string;
}

/**
 * Fully-resolved recreate target: the EXACT path to rebuild plus the git inputs
 * needed to do it, derived server-side from persisted state (ticket
 * frontmatter / session row) — never from a client-supplied path.
 */
export interface RecreateTarget {
  kind: 'ticket' | 'session';
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
 * ticket/session itself cannot be found.
 */
export async function resolveRecreateTarget(
  deps: RecreateTargetDeps,
  target: RecreateTargetInput,
): Promise<RecreateTarget | null> {
  const { projectsDir } = deps;

  if (target.kind === 'ticket') {
    const detail =
      'id' in target
        ? await getTicketDetailById(projectsDir, target.id)
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
      kind: 'ticket',
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
  // inputs (repository/branch) come from the linked ticket.
  const session = getSessionById(target.id);
  if (!session) return null;

  let repository: string | null = null;
  let branch: string | null = null;
  let ticketWorktreePath = '';
  if (session.ticketId) {
    const detail = await getTicketDetailById(projectsDir,
      session.ticketId,
    );
    if (detail) {
      repository = detail.workspace.repository ?? null;
      branch = detail.workspace.branch ?? null;
      ticketWorktreePath = detail.workspace.worktreePath ?? '';
    }
  } else if (session.projectSlug && session.ticketSlug) {
    const detail = await getTicketDetail(
      projectsDir,
      session.projectSlug,
      session.ticketSlug,
    );
    if (detail) {
      repository = detail.workspace.repository ?? null;
      branch = detail.workspace.branch ?? null;
      ticketWorktreePath = detail.workspace.worktreePath ?? '';
    }
  } else if (session.ticketSlug) {
    const detail = await getTicketDetailById(projectsDir,
      session.ticketSlug,
    );
    if (detail) {
      repository = detail.workspace.repository ?? null;
      branch = detail.workspace.branch ?? null;
      ticketWorktreePath = detail.workspace.worktreePath ?? '';
    }
  }

  const worktreePath = session.path || ticketWorktreePath;
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
