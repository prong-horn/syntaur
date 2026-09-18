import type { TicketDetail, TicketTransitionAction } from '../hooks/useProjects';
import { recreateRequest, type RecreateIdentity } from './recreate';

export interface DispatchVerbResult {
  requestId?: string;
  state?: string;
  agentId?: string;
  entryId?: string;
  error?: string;
  warning?: string;
}

export interface RunTicketVerbOptions {
  reason?: string;
  /** Dispatch recipient for `start` only — does not change chat default participant. */
  agent?: string;
  /** Audit attribution (`--by` on CLI). */
  by?: string;
}

export interface VerbResult {
  ticket: TicketDetail;
  next: string | null;
  dispatch?: DispatchVerbResult;
  warnings?: string[];
}

/** User-visible messages after a lifecycle verb with optional stage dispatch. */
export function dispatchVerbMessages(result: VerbResult): string[] {
  const messages: string[] = [];
  if (result.warnings?.length) {
    messages.push(...result.warnings);
  }
  const dispatch = result.dispatch;
  if (!dispatch) return messages;
  if (dispatch.state === 'failed' || dispatch.state === 'offline' || dispatch.state === 'unknown') {
    messages.push(dispatch.error || dispatch.warning || `Dispatch ${dispatch.state}`);
  }
  return messages;
}

export async function runTicketVerb(
  id: string,
  verb: string,
  options: RunTicketVerbOptions = {},
): Promise<VerbResult> {
  const body: Record<string, string> = {};
  if (options.reason) body.reason = options.reason;
  if (options.agent) body.agent = options.agent;
  if (options.by) body.by = options.by;

  const response = await fetch(`/api/tickets/${id}/verbs/${verb}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const next = (payload as { next?: string } | null)?.next;
    const base = (payload as { error?: string } | null)?.error || `HTTP ${response.status}`;
    throw new Error(next ? `${base} — Next: ${next}` : base);
  }

  const result = payload as VerbResult;
  return {
    ticket: result.ticket,
    next: result.next ?? null,
    ...(result.dispatch ? { dispatch: result.dispatch } : {}),
    ...(result.warnings?.length ? { warnings: result.warnings } : {}),
  };
}

/** @deprecated Use {@link runTicketVerb} */
export const runTicketTransition = (
  id: string,
  action: TicketTransitionAction,
  reason?: string,
): Promise<VerbResult> => runTicketVerb(id, action.command, { reason });

/** @deprecated Use {@link runTicketVerb} */
export const runTicketTransitionById = runTicketTransition;

export async function deleteTicket(id: string): Promise<void> {
  const response = await fetch(`/api/tickets/${id}`, { method: 'DELETE' });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }
}

export function verbNeedsReason(verb: string): boolean {
  return verb === 'block' || verb === 'park' || verb === 'drop';
}

/** @deprecated Use {@link verbNeedsReason} */
export function transitionNeedsReason(action: TicketTransitionAction): boolean {
  return verbNeedsReason(action.command) || action.requiresReason;
}

/**
 * Set the assignee on a ticket via the dedicated assignee endpoint. Body content
 * stays untouched — only the frontmatter `assignee:` field changes.
 */
export async function claimTicket(args: {
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

/** @deprecated Use {@link claimTicket} */
export const claimTicketById = claimTicket;

export async function updateTicketTitle(args: {
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

/** @deprecated Use {@link updateTicketTitle} */
export const updateTicketTitleById = updateTicketTitle;

export type QuickLogType = 'question' | 'note' | 'progress' | 'decision';

/** Post a single typed log entry to a ticket. */
export async function postQuickLog(args: {
  id: string;
  body: string;
  type?: QuickLogType;
}): Promise<void> {
  const response = await fetch(`/api/tickets/${args.id}/log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      body: args.body,
      type: args.type ?? 'note',
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((payload as { error?: string } | null)?.error || `HTTP ${response.status}`);
  }
}

const CLAIM_AS_STORAGE_KEY = 'syntaur:dashboard:claimAs';
const CLAIM_AS_DEFAULT = 'human';

export function readClaimAs(): string {
  try {
    const stored = window.localStorage.getItem(CLAIM_AS_STORAGE_KEY);
    if (stored && stored.trim().length > 0) return stored.trim();
  } catch {
    // ignore
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

export async function getTicketRepositoryCandidates(
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
  baseUsed: string;
  exact: boolean;
  branch: string | null;
  alreadyExisted?: boolean;
}

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

export { validateBranchName } from '@shared/branch-name';

export interface RepositoryBranches {
  branches: string[];
  defaultBranch: string | null;
}

export interface SourceTicket {
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
  id: string,
  repo: string,
): Promise<RepositoryBranches> {
  const response = await fetch(
    `/api/tickets/${id}/repository-branches?repo=${encodeURIComponent(repo)}`,
  );
  return readJsonOrThrow<RepositoryBranches>(response);
}

export async function getSourceTickets(id: string): Promise<SourceTicket[]> {
  const response = await fetch(`/api/tickets/${id}/source-tickets`);
  const body = await readJsonOrThrow<{ sourceTickets: SourceTicket[] }>(response);
  return body.sourceTickets;
}
