/**
 * REST wrappers for the assignment chat, plus the pure reducer the hook drives.
 *
 * The reducer lives here rather than inside the hook so it unit-tests under the
 * node-env dashboard vitest config (no jsdom, no React) — the same split
 * `wsManager.ts` uses.
 *
 * URLs are relative so they inherit the dashboard origin; the dev/preview server
 * proxies `/api`.
 */

import type {
  ChatAgentSummary,
  ChatItem,
  ChatItemFrame,
  ChatSessionFrame,
  ChatSessionSummary,
  ItemPatch,
} from './chat-types';

export interface ChatItemsPage {
  items: ChatItem[];
  /** `seqFirst` of the oldest item in the page; null when the page is empty. */
  oldestSeq: number | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...(init.headers ?? {}) } : init?.headers,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // non-JSON body; keep the status line
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export function fetchChatItems(
  assignmentId: string,
  opts: { before?: number; limit?: number } = {},
): Promise<ChatItemsPage> {
  const params = new URLSearchParams();
  if (typeof opts.before === 'number') params.set('before', String(opts.before));
  if (typeof opts.limit === 'number') params.set('limit', String(opts.limit));
  const query = params.toString();
  return request<ChatItemsPage>(
    `/api/assignments/${encodeURIComponent(assignmentId)}/chat/items${query ? `?${query}` : ''}`,
  );
}

export function fetchChatSession(
  assignmentId: string,
  agentId?: string | null,
): Promise<{ session: ChatSessionSummary | null }> {
  const query = agentId ? `?agent=${encodeURIComponent(agentId)}` : '';
  return request<{ session: ChatSessionSummary | null }>(
    `/api/assignments/${encodeURIComponent(assignmentId)}/chat/session${query}`,
  );
}

export function fetchChatAgents(): Promise<{ agents: ChatAgentSummary[]; errors: string[] }> {
  return request<{ agents: ChatAgentSummary[]; errors: string[] }>('/api/chat/agents');
}

export function sendChatMessage(
  assignmentId: string,
  text: string,
  agentId?: string | null,
): Promise<{ messageId: string }> {
  return request<{ messageId: string }>(
    `/api/assignments/${encodeURIComponent(assignmentId)}/chat/messages`,
    { method: 'POST', body: JSON.stringify({ text, ...(agentId ? { agentId } : {}) }) },
  );
}

export function withdrawChatMessage(assignmentId: string, messageId: string): Promise<{ withdrawn: boolean }> {
  return request<{ withdrawn: boolean }>(
    `/api/assignments/${encodeURIComponent(assignmentId)}/chat/messages/${encodeURIComponent(messageId)}`,
    { method: 'DELETE' },
  );
}

export function cancelChatTurn(assignmentId: string, agentId?: string | null): Promise<{ cancelled: boolean }> {
  return request<{ cancelled: boolean }>(
    `/api/assignments/${encodeURIComponent(assignmentId)}/chat/cancel`,
    { method: 'POST', body: JSON.stringify(agentId ? { agentId } : {}) },
  );
}

export function answerChatPermission(
  assignmentId: string,
  requestId: string,
  optionId: string,
): Promise<{ answered: boolean }> {
  return request<{ answered: boolean }>(
    `/api/assignments/${encodeURIComponent(assignmentId)}/chat/permissions/${encodeURIComponent(requestId)}`,
    { method: 'POST', body: JSON.stringify({ optionId }) },
  );
}

// --- pure reducer ----------------------------------------------------------

export interface ChatState {
  /** Keyed by `itemId`; render order is `sortItems`. */
  items: Map<string, ChatItem>;
  session: ChatSessionSummary | null;
  /** `seqFirst` of the oldest loaded item, for backwards paging. */
  oldestSeq: number | null;
  /** False once a page comes back short of the limit. */
  hasMore: boolean;
}

export function emptyChatState(): ChatState {
  return { items: new Map(), session: null, oldestSeq: null, hasMore: true };
}

/** Chat order: by the seq the item first appeared at, ties broken by id. */
export function sortItems(items: Iterable<ChatItem>): ChatItem[] {
  return [...items].sort((a, b) => a.seqFirst - b.seqFirst || a.itemId.localeCompare(b.itemId));
}

/**
 * Apply one patch. `retract` deletes (the fold rule turned that bubble into a
 * work card's lead); `upsert` replaces wholesale — items are immutable snapshots
 * from the server, never merged client-side.
 */
export function applyPatch(state: ChatState, patch: ItemPatch): ChatState {
  const items = new Map(state.items);
  if (patch.op === 'retract') {
    if (!items.delete(patch.itemId)) return state;
  } else {
    items.set(patch.item.itemId, patch.item);
  }
  return { ...state, items };
}

/** Merge a REST page in without disturbing anything already streamed. */
export function mergePage(state: ChatState, page: ChatItemsPage, limit: number): ChatState {
  const items = new Map(state.items);
  for (const item of page.items) items.set(item.itemId, item);
  return {
    ...state,
    items,
    oldestSeq:
      page.oldestSeq === null
        ? state.oldestSeq
        : state.oldestSeq === null
          ? page.oldestSeq
          : Math.min(state.oldestSeq, page.oldestSeq),
    hasMore: page.items.length >= limit,
  };
}

/**
 * Fold a WS frame into the state, ignoring anything for another assignment —
 * the `/ws` broadcast is a flat fan-out with no topics (Decision 3).
 */
export function applyFrame(
  state: ChatState,
  assignmentId: string,
  type: 'chat-item' | 'chat-session',
  payload: unknown,
): ChatState {
  if (!payload || typeof payload !== 'object') return state;
  const frame = payload as Partial<ChatItemFrame & ChatSessionFrame>;
  if (frame.assignmentId !== assignmentId) return state;

  if (type === 'chat-item' && frame.patch) return applyPatch(state, frame.patch);
  if (type === 'chat-session' && frame.session) return { ...state, session: frame.session };
  return state;
}

/** The turn that is still running, if any — what drives the working indicator. */
export function openTurn(items: Iterable<ChatItem>): { startedAt: string } | null {
  for (const item of items) {
    if (item.type === 'turn.status' && item.state === 'running') return { startedAt: item.startedAt };
  }
  return null;
}

/**
 * The elapsed working time, measured on SYNTAUR's clock. claude-agent-acp emits
 * no thinking signal at all — it is silent for ~25 s at the inherited xhigh
 * effort — so the spinner cannot be driven by adapter activity (RESULTS.md §09).
 */
export function workingFor(items: Iterable<ChatItem>, nowMs: number): { since: string; elapsedMs: number } | null {
  const turn = openTurn(items);
  if (!turn) return null;
  const started = Date.parse(turn.startedAt);
  return {
    since: turn.startedAt,
    elapsedMs: Number.isFinite(started) ? Math.max(0, nowMs - started) : 0,
  };
}
