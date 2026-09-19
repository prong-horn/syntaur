/**
 * Ticket-family resource descriptors and write helpers. Keeps log/acceptance
 * reads on the shared store without extending the central catalog.
 */
import { mutate, type MutationMethod } from './mutate';
import { apiUrl, sessionWriteTargets, ticketWriteTargets, type Resource } from './resources';
import type { ResourceStore } from './cache';
import type { TicketLogEntryDetail } from './types';

export interface TicketLogResponse {
  path: string;
  entries: TicketLogEntryDetail[];
}

export interface JournalAppendPayload {
  type: string;
  body: string;
  verdict?: 'approve' | 'changes';
  open?: string;
  answers?: string;
}

export const ticketResources = {
  log: (ticketId: string, type?: string | null): Resource<TicketLogResponse> => ({
    url: apiUrl(['tickets', ticketId, 'log'], type ? { type } : undefined),
    tags: ['ticket', 'ticket-detail'],
    meta: { kind: 'ticket-detail', ticketId },
  }),
} as const;

interface WriteOptions {
  store?: ResourceStore;
}

export async function appendTicketLogEntry(
  ticketId: string,
  payload: JournalAppendPayload,
  options: WriteOptions = {},
): Promise<void> {
  await mutate('POST', apiUrl(['tickets', ticketId, 'log']), payload, {
    store: options.store,
    invalidates: ticketWriteTargets(ticketId),
  });
}

export async function patchAcceptanceCriterion(
  ticketId: string,
  index: number,
  checked: boolean,
  options: WriteOptions = {},
): Promise<void> {
  await mutate(
    'PATCH',
    apiUrl(['tickets', ticketId, 'acceptance-criteria', String(index)]),
    { checked },
    { store: options.store, invalidates: ticketWriteTargets(ticketId) },
  );
}

export async function markAgentSessionStopped(
  sessionId: string,
  options: WriteOptions = {},
): Promise<void> {
  await mutate(
    'PATCH',
    apiUrl(['agent-sessions', sessionId]),
    { status: 'stopped' },
    { store: options.store, invalidates: sessionWriteTargets },
  );
}

/** Inbox row mutations that are not ticket-scoped (snooze/unsnooze). */
export async function mutateInboxRow(
  method: MutationMethod,
  url: string,
  body: Record<string, unknown> | undefined,
  ticketId: string,
  projectSlug: string | null,
  options: WriteOptions = {},
): Promise<void> {
  const invalidates =
    url.includes('/api/inbox/snoozes')
      ? [{ tag: 'inbox' as const }]
      : ticketWriteTargets(ticketId, projectSlug);
  await mutate(method, url, body, { store: options.store, invalidates });
}
