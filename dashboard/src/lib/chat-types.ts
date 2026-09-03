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
  | 'handoff'
  | 'agent.message'
  | 'agent.thought'
  | 'agent.work'
  | 'agent.plan'
  | 'permission.request'
  | 'question'
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

/**
 * `queued` = no target started, `partial` = some did, `sent` = every target did.
 * `replayed` is a user bubble the adapter replayed during a `session/load`.
 */
export type UserMessageState = 'queued' | 'partial' | 'sent' | 'withdrawn' | 'replayed';

export interface UserMessageItem extends ChatItemBase {
  type: 'user.message';
  messageId: string;
  text: string;
  state: UserMessageState;
  /** Absent on a replayed bubble and on a phase-2 row — neither was routed. */
  targets?: string[];
  deliveredTo?: string[];
  mentions?: string[];
  unknown?: string[];
}

/** One agent handing the conversation to another (§5.3's `handoff` row). */
export interface HandoffItem extends ChatItemBase {
  type: 'handoff';
  handoffId: string;
  fromAgentId: string;
  toAgentId: string;
  triggerItemId: string | null;
  hop: number;
  budget: number;
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

export interface QuestionItem extends ChatItemBase {
  type: 'question';
  requestId: string;
  text: string;
  options: Array<{ id: string; label: string }> | null;
  answer: string | null;
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
  /** What the turn answered; absent on a phase-2 row that carried no trigger. */
  trigger?: TurnTrigger;
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
  | HandoffItem
  | AgentMessageItem
  | AgentThoughtItem
  | AgentWorkItem
  | AgentPlanItem
  | PermissionRequestItem
  | QuestionItem
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

/** What a queued turn is answering; mirrors `TurnTrigger` in `src/chat/types.ts`. */
export type TurnTrigger =
  | { kind: 'human'; messageId: string }
  | { kind: 'handoff'; handoffId: string; fromAgentId: string; hop: number };

/** The four-tier cwd resolution chain for chat sessions. */
export type CwdTier = 'worktree' | 'repository' | 'project' | 'home';

export type ChatCommandAction =
  | { kind: 'prompt' }
  | { kind: 'set-config'; configId: string; value: string };

export interface ChatCommand {
  name: string;
  description: string;
  inputHint: string | null;
  action: ChatCommandAction;
}

export type ChatCommandsSource = 'session' | 'harness-cache';

export interface ChatSessionSummary {
  assignmentId: string;
  agentId: string;
  harness: 'claude' | 'codex' | 'cursor';
  acpSessionId: string | null;
  adapterVersion: string | null;
  state: ChatSessionState;
  model: string | null;
  mode: string | null;
  effort: string | null;
  lastTurnAt: string | null;
  cumulative: ModelTokens | null;
  queued: Array<{ text: string; trigger: TurnTrigger }>;
  /** Highest chat-level `seq` this session has been shown (Decision 4). */
  lastDeliveredSeq: number;
  error?: string | null;
  /** Resolved working directory for this session. */
  cwd?: string | null;
  /** Which tier of the resolution chain produced the cwd. */
  cwdTier?: CwdTier | null;
  commands: ChatCommand[];
  commandsSource: ChatCommandsSource | null;
}

/**
 * The per-assignment participant set — `<assignmentDir>/chat/participants.json`
 * (Decision 1).
 */
export interface Participants {
  agents: string[];
  defaultAgent: string | null;
  hopBudget?: number;
}

export type RespondsTo = 'mentions' | 'all-human' | 'none';

export interface ChatAgentSummary {
  id: string;
  name: string;
  color: string;
  harness: 'claude' | 'codex' | 'cursor';
  model: string | null;
  mode: string | null;
  effort: string | null;
  respondsTo: RespondsTo;
  description: string | null;
  /** An emoji or one to two characters; the name's initial when unset. */
  avatar: string;
  default: boolean;
  /** Absolute path of the definition file; null for a builtin. */
  source: string | null;
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

export interface ChatParticipantsFrame {
  assignmentId: string;
  participants: Participants;
  agents: ChatAgentSummary[];
}

export type ChatWsFrame = ChatItemFrame | ChatSessionFrame | ChatParticipantsFrame;

/** Narrowing helper — a `chat-item` frame always carries a `patch`. */
export function isChatItemFrame(frame: ChatWsFrame): frame is ChatItemFrame {
  return 'patch' in frame;
}
