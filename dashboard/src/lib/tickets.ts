import type { TicketDetail, TicketTransitionAction } from '../hooks/useProjects';
import { recreateRequest, type RecreateIdentity } from './recreate';

interface TransitionResponse {
  ticket: TicketDetail;
}

export async function runTicketTransition(
  projectSlug: string,
  ticketSlug: string,
  action: TicketTransitionAction,
  reason?: string,
): Promise<TicketDetail> {
  const response = await fetch(
    `/api/projects/${projectSlug}/tickets/${ticketSlug}/transitions/${action.command}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reason ? { reason } : {}),
    },
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }

  return (payload as TransitionResponse).ticket;
}

export async function overrideTicketStatus(
  projectSlug: string,
  ticketSlug: string,
  status: string,
): Promise<TicketDetail> {
  const response = await fetch(
    `/api/projects/${projectSlug}/tickets/${ticketSlug}/status-override`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    },
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }

  return (payload as { ticket: TicketDetail }).ticket;
}

export async function deleteTicket(
  projectSlug: string,
  ticketSlug: string,
): Promise<void> {
  const response = await fetch(
    `/api/projects/${projectSlug}/tickets/${ticketSlug}`,
    { method: 'DELETE' },
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }
}

export function transitionNeedsReason(action: TicketTransitionAction): boolean {
  return action.requiresReason || action.command === 'block';
}

export async function runTicketTransitionById(
  id: string,
  action: TicketTransitionAction,
  reason?: string,
): Promise<TicketDetail> {
  const response = await fetch(
    `/api/tickets/${id}/transitions/${action.command}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reason ? { reason } : {}),
    },
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }

  return (payload as TransitionResponse).ticket;
}

export async function overrideTicketStatusById(
  id: string,
  status: string,
): Promise<TicketDetail> {
  const response = await fetch(
    `/api/tickets/${id}/status-override`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    },
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }

  return (payload as { ticket: TicketDetail }).ticket;
}

/**
 * Set the assignee on a project-scoped ticket via the dedicated
 * assignee endpoint. Body content stays untouched — only the
 * frontmatter `assignee:` field changes.
 */
export async function claimTicket(args: {
  projectSlug: string;
  ticketSlug: string;
  assignee: string | null;
}): Promise<TicketDetail> {
  const response = await fetch(
    `/api/projects/${args.projectSlug}/tickets/${args.ticketSlug}/assignee`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignee: args.assignee }),
    },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((payload as { error?: string } | null)?.error || `HTTP ${response.status}`);
  }
  return (payload as { ticket: TicketDetail }).ticket;
}

/** Standalone-ticket variant of {@link claimTicket}. */
export async function claimTicketById(args: {
  id: string;
  assignee: string | null;
}): Promise<TicketDetail> {
  const response = await fetch(`/api/tickets/${args.id}/assignee`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignee: args.assignee }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((payload as { error?: string } | null)?.error || `HTTP ${response.status}`);
  }
  return (payload as { ticket: TicketDetail }).ticket;
}

export async function updateTicketTitle(args: {
  projectSlug: string;
  ticketSlug: string;
  title: string;
}): Promise<TicketDetail> {
  const response = await fetch(
    `/api/projects/${args.projectSlug}/tickets/${args.ticketSlug}/title`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: args.title }),
    },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((payload as { error?: string } | null)?.error || `HTTP ${response.status}`);
  }
  return (payload as { ticket: TicketDetail }).ticket;
}

export async function updateTicketTitleById(args: {
  id: string;
  title: string;
}): Promise<TicketDetail> {
  const response = await fetch(`/api/tickets/${args.id}/title`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: args.title }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((payload as { error?: string } | null)?.error || `HTTP ${response.status}`);
  }
  return (payload as { ticket: TicketDetail }).ticket;
}

export type QuickCommentType = 'question' | 'note' | 'feedback';

/**
 * Post a single quick comment to a project-scoped or standalone
 * ticket. Wraps the existing /comments endpoints.
 */
export async function postQuickComment(args: {
  projectSlug: string | null;
  ticketSlug?: string;
  id?: string;
  body: string;
  type?: QuickCommentType;
  author?: string;
}): Promise<void> {
  let url: string;
  if (args.projectSlug && args.ticketSlug) {
    url = `/api/projects/${args.projectSlug}/tickets/${args.ticketSlug}/comments`;
  } else if (args.id) {
    url = `/api/tickets/${args.id}/comments`;
  } else {
    throw new Error('postQuickComment requires either (projectSlug + ticketSlug) or id');
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      body: args.body,
      type: args.type ?? 'note',
      author: args.author,
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((payload as { error?: string } | null)?.error || `HTTP ${response.status}`);
  }
}

/**
 * Read/write the dashboard-side "claim as" identity used by
 * {@link claimTicket}. There is no "current agent" in the browser, so we
 * persist the user's preferred value in localStorage with `'human'` as
 * default. The first-use flow opens a dialog; subsequent claims are
 * one-click. Hold Shift on the claim button to re-open the dialog.
 */
const CLAIM_AS_STORAGE_KEY = 'syntaur:dashboard:claimAs';
const CLAIM_AS_DEFAULT = 'human';

export function readClaimAs(): string {
  try {
    const stored = window.localStorage.getItem(CLAIM_AS_STORAGE_KEY);
    if (stored && stored.trim().length > 0) return stored.trim();
  } catch {
    // ignore — storage may be unavailable (private mode, etc.)
  }
  return CLAIM_AS_DEFAULT;
}

export function writeClaimAs(value: string | null): void {
  try {
    if (value === null || value.trim().length === 0) {
      window.localStorage.removeItem(CLAIM_AS_STORAGE_KEY);
    } else {
      window.localStorage.setItem(CLAIM_AS_STORAGE_KEY, value.trim());
    }
  } catch {
    // ignore
  }
}

export function hasStoredClaimAs(): boolean {
  try {
    const stored = window.localStorage.getItem(CLAIM_AS_STORAGE_KEY);
    return Boolean(stored && stored.trim().length > 0);
  } catch {
    return false;
  }
}

// --- Worktree creation + candidate discovery ---

export interface RepositoryCandidate {
  path: string;
  source: 'project' | 'sibling';
  sourceTicketSlug: string | null;
}

export interface CreateWorktreePayload {
  repository: string;
  branch?: string;
  parentBranch?: string;
}

/**
 * Mutation-side errors from the worktree create endpoint can carry the raw
 * git stderr. The dialog renders it in a `<pre>` so the user can see what
 * git actually said (e.g., "fatal: A branch named 'foo' already exists.").
 */
export class CreateWorktreeError extends Error {
  constructor(message: string, public readonly stderr?: string) {
    super(message);
    this.name = 'CreateWorktreeError';
  }
}

async function readError(response: Response): Promise<CreateWorktreeError> {
  const body = await response.json().catch(() => null);
  const error = new CreateWorktreeError(
    (body as { error?: string } | null)?.error || `HTTP ${response.status}`,
    (body as { stderr?: string } | null)?.stderr,
  );
  return error;
}

export async function getProjectRepositoryCandidates(
  projectSlug: string,
): Promise<RepositoryCandidate[]> {
  const response = await fetch(`/api/projects/${projectSlug}/repository-candidates`);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((body as { error?: string } | null)?.error || `HTTP ${response.status}`);
  }
  return (body as { candidates: RepositoryCandidate[] }).candidates;
}

export async function getTicketRepositoryCandidatesById(
  id: string,
): Promise<RepositoryCandidate[]> {
  const response = await fetch(`/api/tickets/${id}/repository-candidates`);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((body as { error?: string } | null)?.error || `HTTP ${response.status}`);
  }
  return (body as { candidates: RepositoryCandidate[] }).candidates;
}

export async function createTicketWorktree(
  projectSlug: string,
  ticketSlug: string,
  payload: CreateWorktreePayload,
): Promise<TicketDetail> {
  const response = await fetch(
    `/api/projects/${projectSlug}/tickets/${ticketSlug}/worktree`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) {
    throw await readError(response);
  }
  const body = await response.json();
  return (body as { ticket: TicketDetail }).ticket;
}

export async function createTicketWorktreeById(
  id: string,
  payload: CreateWorktreePayload,
): Promise<TicketDetail> {
  const response = await fetch(`/api/tickets/${id}/worktree`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  const body = await response.json();
  return (body as { ticket: TicketDetail }).ticket;
}

export interface RecreateWorktreeResult {
  /** Branch name or base ref used to rebuild the worktree. */
  baseUsed: string;
  /** True when the original branch/sha was restored exactly. */
  exact: boolean;
  /** Resulting branch (null when recreated detached). */
  branch: string | null;
  /** True when the directory already existed (idempotent no-op recreate). */
  alreadyExisted?: boolean;
}

/**
 * Rebuild a deleted worktree at its exact recorded path. The server derives the
 * path/repo/branch from persisted state keyed on the identity, so the request
 * body carries no path. Reuses {@link CreateWorktreeError} so callers can render
 * any git stderr.
 */
export async function recreateWorktree(
  identity: RecreateIdentity,
): Promise<RecreateWorktreeResult> {
  const { url } = recreateRequest(identity);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as RecreateWorktreeResult;
}

// Shared branch-name validator (same rules the server enforces) for instant
// inline feedback in the create-worktree modal.
export { validateBranchName } from '@shared/branch-name';

export interface RepositoryBranches {
  branches: string[];
  defaultBranch: string | null;
}

export interface SourceTicket {
  /** Stable unique identifier (the ticket UUID) — use as React key / <option> value. */
  id: string;
  slug: string;
  title: string;
  repository: string;
  branch: string;
}

async function readJsonOrThrow<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((body as { error?: string } | null)?.error || `HTTP ${response.status}`);
  }
  return body as T;
}

export async function getRepositoryBranches(
  projectSlug: string,
  ticketSlug: string,
  repo: string,
): Promise<RepositoryBranches> {
  const response = await fetch(
    `/api/projects/${projectSlug}/tickets/${ticketSlug}/repository-branches?repo=${encodeURIComponent(repo)}`,
  );
  return readJsonOrThrow<RepositoryBranches>(response);
}

export async function getRepositoryBranchesById(
  id: string,
  repo: string,
): Promise<RepositoryBranches> {
  const response = await fetch(
    `/api/tickets/${id}/repository-branches?repo=${encodeURIComponent(repo)}`,
  );
  return readJsonOrThrow<RepositoryBranches>(response);
}

export async function getProjectSourceTickets(
  projectSlug: string,
  ticketSlug: string,
): Promise<SourceTicket[]> {
  const response = await fetch(
    `/api/projects/${projectSlug}/tickets/${ticketSlug}/source-tickets`,
  );
  const body = await readJsonOrThrow<{ sourceTickets: SourceTicket[] }>(response);
  return body.sourceTickets;
}

export async function getSourceTicketsById(id: string): Promise<SourceTicket[]> {
  const response = await fetch(`/api/tickets/${id}/source-tickets`);
  const body = await readJsonOrThrow<{ sourceTickets: SourceTicket[] }>(response);
  return body.sourceTickets;
}
