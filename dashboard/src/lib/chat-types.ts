/**
 * Wire shape of the assignment-chat API and the `chat-item` / `chat-session` WS
 * frames.
 *
 * The SPA is a separate TS project and cannot import `src/chat/types.ts`, so the
 * SPA-facing subset (`ChatItem`, `ChatSessionSummary`, `ChatWsFrame`) is
 * re-declared here — the same mirroring `wsManager.ts` does for `WsMessageType`
 * and `lib/inbox.ts` does for the inbox contract. Keep it in step with
 * `src/chat/types.ts`.
 *
 * No React / DOM dependencies, so it unit-tests under the node-env dashboard
 * vitest config.
 */

export type ChatItemType =
  | 'user.message'
  | 'agent.message'
  | 'agent.thought'
  | 'agent.work'
  | 'agent.plan'
  | 'permission.request'
  | 'turn.status'
  | 'system';

export interface ChatItemBase {
  itemId: string;
  assignmentId: string;
  turnId: string | null;
  agentId: string;
  type: ChatItemType;
  ts: string;
  seqFirst: number;
  seqLast: number;
  sealed: boolean;
}

export type UserMessageState = 'queued' | 'sent' | 'withdrawn' | 'replayed';

export interface UserMessageItem extends ChatItemBase {
  type: 'user.message';
  messageId: string;
  text: string;
  state: UserMessageState;
}

export interface AgentMessageItem extends ChatItemBase {
  type: 'agent.message';
  messageId: string;
  text: string;
}

export interface AgentThoughtItem extends ChatItemBase {
  type: 'agent.thought';
  text: string;
}

export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export type ToolRowContent =
  | { type: 'text'; text: string }
  | { type: 'diff'; path: string; oldText: string | null; newText: string }
  | { type: 'terminal'; terminalId: string }
  | { type: 'other'; text: string };

export interface ToolCallLocation {
  path: string;
  line?: number | null;
}

export interface ToolRow {
  toolCallId: string;
  kind: ToolKind;
  title: string;
  status: 'running' | 'completed' | 'failed';
  locations: ToolCallLocation[];
  content: ToolRowContent[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface WorkSummary {
  reads: number;
  edits: number;
  runs: number;
  failed: number;
  durationMs: number;
}

export interface AgentWorkItem extends ChatItemBase {
  type: 'agent.work';
  lead?: string;
  tools: ToolRow[];
  summary: WorkSummary;
}

export interface PlanEntry {
  content: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
}

export interface AgentPlanItem extends ChatItemBase {
  type: 'agent.plan';
  entries: PlanEntry[];
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export interface PermissionRequestItem extends ChatItemBase {
  type: 'permission.request';
  requestId: string;
  toolCall: { toolCallId?: string; title?: string; kind?: ToolKind | null };
  options: PermissionOption[];
  answer?: string;
  cancelled?: boolean;
  timedOut?: boolean;
}

export interface TurnUsage {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens?: number | null;
  cachedReadTokens?: number | null;
  cachedWriteTokens?: number | null;
}

export interface TurnStatusItem extends ChatItemBase {
  type: 'turn.status';
  state: 'running' | 'ended';
  stopReason?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  usage?: TurnUsage | null;
  cost?: number | null;
  contextUsed?: number;
  contextSize?: number;
}

export type SystemLevel = 'info' | 'warn' | 'error';

export interface SystemItem extends ChatItemBase {
  type: 'system';
  level: SystemLevel;
  text: string;
}

export type ChatItem =
  | UserMessageItem
  | AgentMessageItem
  | AgentThoughtItem
  | AgentWorkItem
  | AgentPlanItem
  | PermissionRequestItem
  | TurnStatusItem
  | SystemItem;

export type ItemPatch =
  | { op: 'upsert'; item: ChatItem }
  | { op: 'retract'; itemId: string };

export type ChatSessionState =
  | 'none'
  | 'spawning'
  | 'ready'
  | 'running'
  | 'idle'
  | 'stopped'
  | 'error';

export interface ModelTokens {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  total: number;
  cost: number;
}

export interface ChatSessionSummary {
  assignmentId: string;
  agentId: string;
  harness: 'claude' | 'codex';
  acpSessionId: string | null;
  adapterVersion: string | null;
  state: ChatSessionState;
  model: string | null;
  mode: string | null;
  effort: string | null;
  lastTurnAt: string | null;
  cumulative: ModelTokens | null;
  queued: Array<{ messageId: string; text: string }>;
  error?: string | null;
}

export interface ChatAgentSummary {
  id: string;
  name: string;
  color: string;
  harness: 'claude' | 'codex';
  default: boolean;
  /** Null when the adapter binary resolved on PATH; the install hint otherwise. */
  missing: string | null;
}

export interface ChatItemFrame {
  assignmentId: string;
  patch: ItemPatch;
}

export interface ChatSessionFrame {
  assignmentId: string;
  agentId: string;
  session: ChatSessionSummary;
}

export type ChatWsFrame = ChatItemFrame | ChatSessionFrame;

/** Narrowing helper — a `chat-item` frame always carries a `patch`. */
export function isChatItemFrame(frame: ChatWsFrame): frame is ChatItemFrame {
  return 'patch' in frame;
}
