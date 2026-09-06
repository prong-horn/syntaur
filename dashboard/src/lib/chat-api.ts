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
  AgentDefinition,
  AgentDefinitionInput,
  AgentTestResult,
  ChatAgentSummary,
  ChatAgentsFrame,
  ChatHarnessSummary,
  ChatItem,
  ChatItemFrame,
  ChatParticipantsFrame,
  ChatSessionFrame,
  ChatSessionSummary,
  ItemPatch,
  Participants,
} from './chat-types';

/** The author sentinels the server stamps on assignment-scope rows. */
export const HUMAN_AGENT_ID = 'human';
export const SYSTEM_AGENT_ID = 'system';

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

export function fetchChatAgent(id: string): Promise<{ definition: AgentDefinition }> {
  return request<{ definition: AgentDefinition }>(`/api/chat/agents/${encodeURIComponent(id)}`);
}

export function createChatAgent(
  id: string,
  input: AgentDefinitionInput,
): Promise<{ agent: ChatAgentSummary; definition: AgentDefinition }> {
  return request<{ agent: ChatAgentSummary; definition: AgentDefinition }>(
    `/api/chat/agents/${encodeURIComponent(id)}`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export function updateChatAgent(
  id: string,
  input: AgentDefinitionInput,
): Promise<{ agent: ChatAgentSummary; definition: AgentDefinition }> {
  return request<{ agent: ChatAgentSummary; definition: AgentDefinition }>(
    `/api/chat/agents/${encodeURIComponent(id)}`,
    { method: 'PUT', body: JSON.stringify(input) },
  );
}

export function deleteChatAgent(
  id: string,
): Promise<{ deleted: string; restoredBuiltin: boolean; agents: ChatAgentSummary[] }> {
  return request<{ deleted: string; restoredBuiltin: boolean; agents: ChatAgentSummary[] }>(
    `/api/chat/agents/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
}

export function testChatAgent(id: string): Promise<AgentTestResult> {
  return request<AgentTestResult>(`/api/chat/agents/${encodeURIComponent(id)}/test`, {
    method: 'POST',
  });
}

export function fetchChatHarnesses(): Promise<{ harnesses: ChatHarnessSummary[] }> {
  return request<{ harnesses: ChatHarnessSummary[] }>('/api/chat/harnesses');
}

export function refreshChatHarness(id: string): Promise<{ harness: ChatHarnessSummary }> {
  return request<{ harness: ChatHarnessSummary }>(
    `/api/chat/harnesses/${encodeURIComponent(id)}/refresh`,
    { method: 'POST' },
  );
}

export interface ChatParticipantsPayload {
  participants: Participants;
  agents: ChatAgentSummary[];
}

export function fetchChatParticipants(assignmentId: string): Promise<ChatParticipantsPayload> {
  return request<ChatParticipantsPayload>(
    `/api/assignments/${encodeURIComponent(assignmentId)}/chat/participants`,
  );
}

export function putChatParticipants(
  assignmentId: string,
  next: Participants,
): Promise<ChatParticipantsPayload> {
  return request<ChatParticipantsPayload>(
    `/api/assignments/${encodeURIComponent(assignmentId)}/chat/participants`,
    { method: 'PUT', body: JSON.stringify(next) },
  );
}

export function sendChatMessage(
  assignmentId: string,
  text: string,
  agentId?: string | null,
  opts?: {
    attachmentIds?: string[];
    attachmentMeta?: Record<string, { width?: number; height?: number }>;
  },
): Promise<{ messageId: string }> {
  return request<{ messageId: string }>(
    `/api/assignments/${encodeURIComponent(assignmentId)}/chat/messages`,
    {
      method: 'POST',
      body: JSON.stringify({
        text,
        ...(agentId ? { agentId } : {}),
        ...(opts?.attachmentIds?.length ? { attachmentIds: opts.attachmentIds } : {}),
        ...(opts?.attachmentMeta ? { attachmentMeta: opts.attachmentMeta } : {}),
      }),
    },
  );
}

export interface UploadedChatAttachment {
  id: string;
  mimeType: string;
  bytes: number;
  name: string;
}

export async function uploadChatAttachment(
  assignmentId: string,
  blob: Blob,
  name: string,
  mimeType: string,
): Promise<UploadedChatAttachment> {
  const res = await fetch(`/api/assignments/${encodeURIComponent(assignmentId)}/chat/attachments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-attachment-filename': encodeURIComponent(name),
      'x-attachment-mime': mimeType,
    },
    body: blob,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // keep status line
    }
    throw new Error(message);
  }
  return (await res.json()) as UploadedChatAttachment;
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
  opts?: { allowAllSession?: boolean },
): Promise<{ answered: boolean }> {
  return request<{ answered: boolean }>(
    `/api/assignments/${encodeURIComponent(assignmentId)}/chat/permissions/${encodeURIComponent(requestId)}`,
    {
      method: 'POST',
      body: JSON.stringify({
        optionId,
        ...(opts?.allowAllSession === undefined ? {} : { allowAllSession: opts.allowAllSession }),
      }),
    },
  );
}

export function answerChatQuestion(
  assignmentId: string,
  requestId: string,
  answer: { optionId?: string; text?: string },
): Promise<{ answered: boolean }> {
  return request<{ answered: boolean }>(
    `/api/assignments/${encodeURIComponent(assignmentId)}/chat/questions/${encodeURIComponent(requestId)}`,
    { method: 'POST', body: JSON.stringify(answer) },
  );
}

// --- pure reducer ----------------------------------------------------------

export interface ChatState {
  /** Keyed by `itemId`; render order is `sortItems`. */
  items: Map<string, ChatItem>;
  /** One entry per agent that has a session — a chat holds several now. */
  sessions: Map<string, ChatSessionSummary>;
  /** The attached set; null until the first load answers. */
  participants: Participants | null;
  /** Every definition on disk, for the picker and for author resolution. */
  agents: ChatAgentSummary[];
  /** `seqFirst` of the oldest loaded item, for backwards paging. */
  oldestSeq: number | null;
  /** False once a page comes back short of the limit. */
  hasMore: boolean;
}

export function emptyChatState(): ChatState {
  return {
    items: new Map(),
    sessions: new Map(),
    participants: null,
    agents: [],
    oldestSeq: null,
    hasMore: true,
  };
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
  type: 'chat-item' | 'chat-session' | 'chat-participants' | 'chat-agents',
  payload: unknown,
): ChatState {
  if (!payload || typeof payload !== 'object') return state;

  if (type === 'chat-agents') {
    const frame = payload as Partial<ChatAgentsFrame>;
    if (frame.agents) return { ...state, agents: frame.agents };
    return state;
  }

  const frame = payload as Partial<ChatItemFrame & ChatSessionFrame & ChatParticipantsFrame>;
  if (frame.assignmentId !== assignmentId) return state;

  if (type === 'chat-item' && frame.patch) return applyPatch(state, frame.patch);
  if (type === 'chat-session' && frame.session && frame.agentId) {
    // Upsert BY AGENT: a chat holds one session per participant, and a frame
    // for the implementer must not evict the planner's.
    const sessions = new Map(state.sessions);
    sessions.set(frame.agentId, frame.session);
    return { ...state, sessions };
  }
  if (type === 'chat-participants' && frame.participants) {
    return {
      ...state,
      participants: frame.participants,
      agents: frame.agents ?? state.agents,
    };
  }
  return state;
}

/** The turn that is still running, if any — what drives the working indicator. */
export function openTurn(items: Iterable<ChatItem>): { startedAt: string } | null {
  for (const item of items) {
    if (item.type === 'turn.status' && item.state === 'running') return { startedAt: item.startedAt };
  }
  return null;
}

export interface WorkingState {
  since: string;
  elapsedMs: number;
}

/**
 * Who is working, and for how long, measured on SYNTAUR's clock. Two things
 * make this the only honest source: claude-agent-acp emits no thinking signal
 * at all and is silent for ~25 s at the inherited xhigh effort (RESULTS.md §09),
 * and with several agents in one chat "working" is per agent, not per chat.
 */
export function workingByAgent(items: Iterable<ChatItem>, nowMs: number): Map<string, WorkingState> {
  const working = new Map<string, WorkingState>();
  for (const item of items) {
    if (item.type !== 'turn.status' || item.state !== 'running') continue;
    const started = Date.parse(item.startedAt);
    working.set(item.agentId, {
      since: item.startedAt,
      elapsedMs: Number.isFinite(started) ? Math.max(0, nowMs - started) : 0,
    });
  }
  return working;
}

/**
 * The agents to show chips for: everyone attached, plus anyone with a turn
 * still open. A detach cancels and tears down (Decision 7), but between the
 * click and the cancel resolving the agent is still spending — and an agent
 * with no chip has no interrupt button (code review round 1, finding 5).
 */
export function chipAgents(
  attachedIds: readonly string[],
  working: ReadonlyMap<string, WorkingState>,
): string[] {
  const ids = [...attachedIds];
  for (const agentId of working.keys()) {
    if (!ids.includes(agentId)) ids.push(agentId);
  }
  return ids;
}

export interface ItemAuthor {
  id: string;
  name: string;
  color: string;
  avatar: string;
}

/**
 * Who wrote a row. Every item carries an author now — the human's messages and
 * Syntaur's own routing notices included — so the chat can show an avatar and a
 * colour on all of them rather than assuming one agent owns the whole tab.
 */
export function authorOf(item: { agentId: string }, agents: readonly ChatAgentSummary[]): ItemAuthor {
  if (item.agentId === HUMAN_AGENT_ID) {
    return { id: HUMAN_AGENT_ID, name: 'You', color: 'primary', avatar: 'Y' };
  }
  if (item.agentId === SYSTEM_AGENT_ID) {
    return { id: SYSTEM_AGENT_ID, name: 'Syntaur', color: 'slate', avatar: 'S' };
  }
  const agent = agents.find((a) => a.id === item.agentId);
  if (agent) {
    return { id: agent.id, name: agent.name, color: agent.color, avatar: agent.avatar };
  }
  // A definition deleted since the row was written still renders as itself.
  return {
    id: item.agentId,
    name: item.agentId,
    color: 'slate',
    avatar: ([...item.agentId][0] ?? '?').toUpperCase(),
  };
}

/** The `messageId` a queued entry can be withdrawn by; null for a hop. */
export function withdrawableMessageId(entry: {
  trigger: { kind: string; messageId?: string };
}): string | null {
  return entry.trigger.kind === 'human' ? (entry.trigger.messageId ?? null) : null;
}
