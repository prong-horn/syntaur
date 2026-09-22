import type { TicketDetail, TicketTransitionAction } from '../data/types';
import { ApiError, isApiError } from '../data/client';
import { mutate } from '../data/mutate';
import { getDefaultResourceStore } from '../data/cache';
import { apiUrl, sessionWriteTargets, ticketWriteTargets } from '../data/resources';
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

/**
 * User-visible messages after a lifecycle verb with optional stage dispatch.
 * `suppressed` is deliberately not handled here: the dashboard's verb endpoint never
 * passes `suppressDispatch` (that is a CLI-only `--no-dispatch` flag), so this path
 * never sees that state.
 */
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

/**
 * Run a lifecycle verb. A 200 is a successful move even when its stage
 * dispatch failed or is unknown — `dispatch`/`warnings` carry that outcome and
 * the ticket/board/project/inbox reads are invalidated either way. A refusal
 * rethrows the {@link ApiError} (body, `next` and warnings intact) with the
 * server's `next` hint appended to the message.
 */
export async function runTicketVerb(
  id: string,
  verb: string,
  options: RunTicketVerbOptions = {},
): Promise<VerbResult> {
  const body: Record<string, string> = {};
  if (options.reason) body.reason = options.reason;
  if (options.agent) body.agent = options.agent;
  if (options.by) body.by = options.by;

  let result: VerbResult;
  try {
    result = await mutate<VerbResult>('POST', apiUrl(['tickets', id, 'verbs', verb]), body, {
      invalidates: ticketWriteTargets(id),
    });
  } catch (err) {
    if (isApiError(err) && err.next) {
      throw new ApiError({
        message: `${err.message} — Next: ${err.next}`,
        status: err.status,
        kind: err.kind,
        body: err.body,
        url: err.url,
        cause: err,
      });
    }
    throw err;
  }

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
  await mutate('DELETE', apiUrl(['tickets', id]), undefined, { invalidates: ticketWriteTargets(id) });
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
  const payload = await mutate<{ ticket: TicketDetail }>(
    'PATCH',
    apiUrl(['tickets', args.id, 'assignee']),
    { assignee: args.assignee },
    { invalidates: ticketWriteTargets(args.id) },
  );
  return payload.ticket;
}

/** @deprecated Use {@link claimTicket} */
export const claimTicketById = claimTicket;

export async function updateTicketTitle(args: {
  id: string;
  title: string;
}): Promise<TicketDetail> {
  const payload = await mutate<{ ticket: TicketDetail }>(
    'PATCH',
    apiUrl(['tickets', args.id, 'title']),
    { title: args.title },
    { invalidates: ticketWriteTargets(args.id) },
  );
  return payload.ticket;
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
  await mutate(
    'POST',
    apiUrl(['tickets', args.id, 'log']),
    { body: args.body, type: args.type ?? 'note' },
    { invalidates: ticketWriteTargets(args.id) },
  );
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

/** Worktree errors keep the git `stderr` the server returns for display. */
function toWorktreeError(err: unknown): unknown {
  if (!isApiError(err)) return err;
  const stderr = (err.body as { stderr?: unknown } | null)?.stderr;
  return new CreateWorktreeError(err.message, typeof stderr === 'string' ? stderr : undefined);
}

// Repository/branch/source-ticket lookups are one-shot reads that feed a
// dialog's local form state (fetched when the dialog opens), not shared
// resources; they go through the store's client directly.
function readOnce<T>(url: string): Promise<T> {
  return getDefaultResourceStore().client.requestJson<T>(url);
}

export async function getProjectRepositoryCandidates(
  projectSlug: string,
): Promise<RepositoryCandidate[]> {
  const body = await readOnce<{ candidates: RepositoryCandidate[] }>(
    apiUrl(['projects', projectSlug, 'repository-candidates']),
  );
  return body.candidates;
}

export async function getTicketRepositoryCandidates(
  id: string,
): Promise<RepositoryCandidate[]> {
  const body = await readOnce<{ candidates: RepositoryCandidate[] }>(
    apiUrl(['tickets', id, 'repository-candidates']),
  );
  return body.candidates;
}

export async function createTicketWorktree(
  id: string,
  payload: CreateWorktreePayload,
): Promise<TicketDetail> {
  try {
    const body = await mutate<{ ticket: TicketDetail }>('POST', apiUrl(['tickets', id, 'worktree']), payload, {
      invalidates: ticketWriteTargets(id),
    });
    return body.ticket;
  } catch (err) {
    throw toWorktreeError(err);
  }
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
  try {
    return await mutate<RecreateWorktreeResult>('POST', url, {}, {
      invalidates: identity.kind === 'ticket' ? ticketWriteTargets(identity.id) : sessionWriteTargets,
    });
  } catch (err) {
    throw toWorktreeError(err);
  }
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

export async function getRepositoryBranches(
  id: string,
  repo: string,
): Promise<RepositoryBranches> {
  return readOnce<RepositoryBranches>(apiUrl(['tickets', id, 'repository-branches'], { repo }));
}

export async function getSourceTickets(id: string): Promise<SourceTicket[]> {
  const body = await readOnce<{ sourceTickets: SourceTicket[] }>(apiUrl(['tickets', id, 'source-tickets']));
  return body.sourceTickets;
}
