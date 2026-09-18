import type { StageHandoffReceiptSummary } from '../hooks/useProjects';

export const STAGE_DISPATCH_POST_TIMEOUT_MS = 15_000;

type FetchImpl = typeof fetch;

const RECEIPT_STATES = new Set<StageHandoffReceiptSummary['state']>([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'superseded',
]);

/** Validates a receipt body; returns null for anything malformed. */
export function parseStageHandoffReceipt(value: unknown): StageHandoffReceiptSummary | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.requestId !== 'string' ||
    typeof v.entryId !== 'string' ||
    typeof v.agentId !== 'string' ||
    typeof v.stage !== 'string' ||
    typeof v.state !== 'string' ||
    !RECEIPT_STATES.has(v.state as StageHandoffReceiptSummary['state'])
  ) {
    return null;
  }
  return {
    requestId: v.requestId,
    entryId: v.entryId,
    agentId: v.agentId,
    stage: v.stage,
    state: v.state as StageHandoffReceiptSummary['state'],
    ...(typeof v.turnId === 'string' ? { turnId: v.turnId } : {}),
    ...(typeof v.error === 'string' ? { error: v.error } : {}),
  };
}

export async function readStageDispatchReceipt(
  ticketId: string,
  requestId: string,
  signal?: AbortSignal,
  fetchImpl: FetchImpl = fetch,
): Promise<StageHandoffReceiptSummary | null> {
  const response = await fetchImpl(
    `/api/tickets/${encodeURIComponent(ticketId)}/dispatch/${encodeURIComponent(requestId)}`,
    { signal },
  );
  if (response.status === 404) return null;
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((payload as { error?: string } | null)?.error || `HTTP ${response.status}`);
  }
  const receipt = parseStageHandoffReceipt(payload);
  if (!receipt) throw new Error('Malformed dispatch receipt');
  return receipt;
}

export async function submitStageDispatchPost(args: {
  ticketId: string;
  entryId: string;
  requestId: string;
  source: 'manual' | 'automatic';
  agentId?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}): Promise<
  | {
      timedOut: true;
      response: null;
      payload: null;
    }
  | {
      timedOut: false;
      response: Response;
      payload: unknown;
    }
> {
  const {
    ticketId,
    entryId,
    requestId,
    source,
    agentId,
    fetchImpl = fetch,
    timeoutMs = STAGE_DISPATCH_POST_TIMEOUT_MS,
  } = args;
  const body = {
    entryId,
    requestId,
    source,
    ...(source === 'manual' && agentId ? { agentId } : {}),
  };
  // Own controller: a POST timeout never aborts polling or cancel requests.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`/api/tickets/${encodeURIComponent(ticketId)}/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    return { timedOut: false, response, payload };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { timedOut: true, response: null, payload: null };
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
