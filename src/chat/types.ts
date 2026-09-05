/**
 * Assignment-chat vocabulary — the types every other `src/chat/` module imports.
 *
 * Two layers, per Decision 2:
 *   - `ChatEvent` is the lossless append-only log record (`<assignmentDir>/chat/events.jsonl`).
 *     Nothing is dropped: every ACP frame Syntaur renders plus every Syntaur-originated
 *     lifecycle event lands here in order.
 *   - `ChatItem` is the derived, renderable view (design doc §5.3, eight types). Items are
 *     produced by the pure normalizer and materialised into `chat_items` — a rebuildable
 *     index, never a source of truth.
 *
 * Item ids are `${scopeId}:${ordinal}`: `scopeId` is the broker-minted `turnId` inside a
 * turn, `replay:<n>` inside a `session/load` replay, and `session:<sessionKey>` otherwise;
 * `ordinal` is a per-scope monotonic counter assigned at an item's first upsert and never
 * changed afterwards. Replaying the log in event order therefore reproduces the live ids
 * exactly (`rebuild == live`).
 */

import type {
  ContentBlock,
  PermissionOption,
  PlanEntry,
  RequestPermissionRequest,
  SessionUpdate,
  StopReason,
  ToolCallLocation,
  ToolKind,
  Usage,
} from '@agentclientprotocol/sdk';
import type { ModelTokens } from '../db/engagement-tokens.js';

export type Harness = 'claude' | 'codex' | 'cursor';

// --- Event log -------------------------------------------------------------

/**
 * Everything appended to `chat/events.jsonl`.
 *
 * `acp.*` payloads are the raw ACP objects (a `SessionNotification.update`, a
 * `RequestPermissionRequest`, …). Syntaur-originated kinds carry small structured
 * payloads described on {@link ChatEventPayloads}.
 */
export type ChatEventKind =
  | 'user.message'
  | 'user.message.delivered'
  | 'handoff'
  | 'route.notice'
  | 'turn.start'
  | 'turn.end'
  | 'turn.cancel'
  | 'acp.update'
  | 'acp.permission_request'
  | 'acp.permission_response'
  | 'acp.ext'
  | 'question.answered'
  | 'session.created'
  | 'session.resumed'
  | 'session.load'
  | 'session.loaded'
  | 'session.rotated'
  | 'session.idle'
  | 'session.exited'
  | 'system';

export interface ChatEvent {
  /** Monotonic per assignment, recovered from the log's last line on reopen. */
  seq: number;
  ts: string;
  assignmentId: string;
  agentId: string;
  /** `${assignmentId}:${agentId}` — the broker's session key. */
  sessionKey: string;
  /** Broker-minted UUID, stamped on every event between `turn.start` and its `turn.end`/`turn.cancel`. */
  turnId: string | null;
  kind: ChatEventKind;
  payload: unknown;
}

/**
 * The author ids assignment-scope rows carry (Decision 3). A `user.message` and
 * a routing notice belong to no agent session, so `event.agentId` names the
 * human or Syntaur itself; the SPA resolves both to a name and a colour.
 */
export const HUMAN_AGENT_ID = 'human';
export const SYSTEM_AGENT_ID = 'system';

/**
 * `user.message` payload — `messageId` is minted at queue time and is what
 * DELETE targets. Recorded in the ASSIGNMENT scope (Decision 3), so one event
 * carries the whole routing decision for a fan-out.
 *
 * A later state-only event (the `withdrawn` flip) carries just `messageId` and
 * `state`; the routing fields are absent there, and absent on every phase-2 log
 * line, which is why they are optional.
 */
export interface UserMessagePayload {
  messageId: string;
  text: string;
  state?: UserMessageState;
  /** Every `@token` in the text that named an attached agent, in first-appearance order. */
  mentions?: string[];
  /** The agents the router actually enqueued a turn for. */
  targets?: string[];
  /** `@token`s that named no attached agent — one `route.notice` each. */
  unknown?: string[];
}

/** `user.message.delivered` payload — one per target, right after its `turn.start`. */
export interface UserMessageDeliveredPayload {
  messageId: string;
  agentId: string;
  turnId: string;
}

/**
 * What a turn is answering. A human trigger names the message; a handoff trigger
 * names the `handoffId` minted before the `handoff` event was recorded, which is
 * also how crash repair decides per target whether a hop was ever started
 * (Decision 3).
 */
export type TurnTrigger =
  | { kind: 'human'; messageId: string }
  | { kind: 'handoff'; handoffId: string; fromAgentId: string; hop: number };

/** `turn.start` payload. Phase-2 lines carry a flat `messageId` instead. */
export interface TurnStartPayload {
  trigger: TurnTrigger;
  startedAt: string;
  /** Phase-2 shape, still read by `repairSession` when `trigger` is absent. */
  messageId?: string;
}

/**
 * `handoff` payload. It carries the delegator's sealed reply text so crash
 * repair can re-enqueue the hop from the log alone, without re-running routing
 * (Decision 3).
 */
export interface HandoffPayload {
  handoffId: string;
  fromAgentId: string;
  toAgentId: string;
  /** The item id of the reply that triggered the hop; null when it had none. */
  triggerItemId: string | null;
  text: string;
  hop: number;
  budget: number;
}

/** `turn.end` payload — the resolved `session/prompt` response plus timing. */
export interface TurnEndPayload {
  stopReason: StopReason | 'error';
  endedAt: string;
  durationMs: number;
  usage?: Usage | null;
  /** USD for this turn, from claude's `usage_update.cost` or `priceForModel`. */
  cost?: number | null;
  error?: string;
}

/** `acp.permission_response` payload. */
export interface PermissionResponsePayload {
  requestId: string;
  optionId?: string;
  cancelled?: boolean;
  timedOut?: boolean;
  by?: 'human' | 'auto';
}

/** `acp.ext` payload — a Cursor extension request or notification. */
export interface AcpExtPayload {
  method: string;
  params: unknown;
  requestId?: string;
}

/** `question.answered` payload. */
export interface QuestionAnsweredPayload {
  requestId: string;
  optionId?: string;
  text?: string;
  by: 'human' | 'timeout' | 'cancel';
}

/** `system` payload. */
export interface SystemPayload {
  level: SystemLevel;
  text: string;
}

export type SystemLevel = 'info' | 'warn' | 'error';

/** `acp.permission_request` payload — the ACP request plus the id the client answers on. */
export interface PermissionRequestPayload {
  requestId: string;
  request: RequestPermissionRequest;
}

/** `session.created` / `session.resumed` / `session.rotated` payload. */
export interface SessionCreatedPayload {
  acpSessionId: string;
  harness: Harness;
  adapterVersion: string | null;
  cwd: string;
  applied?: AppliedProfile;
  modes?: unknown;
  configOptions?: unknown;
  /** Present on `session.resumed` when the adapter reattached via `session/load`. */
  via?: 'resume' | 'load';
}

/** What `applyProfile` actually pinned on the adapter session. */
export interface AppliedProfile {
  mode?: string;
  model?: string;
  effort?: string;
}

/** An `acp.update` payload is a raw `SessionUpdate`. */
export type AcpUpdatePayload = SessionUpdate;

// --- Items -----------------------------------------------------------------

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
  /** Null for items outside a turn (adapter notices, replay, session lifecycle). */
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
  /**
   * Routing, present on every message Syntaur routed. All four are ABSENT on a
   * bubble the adapter replayed during a `session/load` (`state: 'replayed'`),
   * which carries no routing at all, and on a phase-2 row.
   */
  targets?: string[];
  /** Targets whose turn has actually started — grows as the fan-out lands. */
  deliveredTo?: string[];
  /** Attached agents named by an `@token`, in first-appearance order. */
  mentions?: string[];
  /** `@token`s that named no attached agent. */
  unknown?: string[];
}

/** One agent handing the conversation to another (§5.3's `handoff` row). */
export interface HandoffItem extends ChatItemBase {
  type: 'handoff';
  handoffId: string;
  fromAgentId: string;
  toAgentId: string;
  /** The reply that caused the hop, for the "linking the trigger" affordance. */
  triggerItemId: string | null;
  hop: number;
  budget: number;
}

export interface AgentMessageItem extends ChatItemBase {
  type: 'agent.message';
  /** The ACP `messageId` when the adapter set one; a synthetic run key otherwise. */
  messageId: string;
  text: string;
}

export interface AgentThoughtItem extends ChatItemBase {
  type: 'agent.thought';
  text: string;
}

/** One rendered block inside a tool row. Mirrors ACP `ToolCallContent`, flattened. */
export type ToolRowContent =
  | { type: 'text'; text: string }
  | { type: 'diff'; path: string; oldText: string | null; newText: string }
  | { type: 'terminal'; terminalId: string }
  | { type: 'other'; text: string };

export interface ToolRow {
  toolCallId: string;
  kind: ToolKind;
  title: string;
  /** Keyed on the terminal value; `pending`/`in_progress` both mean "running". */
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
  /** A short narration bubble that folded into this card (§5.3's one big rule). */
  lead?: string;
  tools: ToolRow[];
  summary: WorkSummary;
}

export interface AgentPlanItem extends ChatItemBase {
  type: 'agent.plan';
  entries: PlanEntry[];
}

export interface PermissionRequestItem extends ChatItemBase {
  type: 'permission.request';
  requestId: string;
  toolCall: { toolCallId?: string; title?: string; kind?: ToolKind | null };
  options: PermissionOption[];
  answer?: string;
  cancelled?: boolean;
  timedOut?: boolean;
  auto?: boolean;
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

export interface TurnStatusItem extends ChatItemBase {
  type: 'turn.status';
  state: 'running' | 'ended';
  /** What the turn answered; absent on a phase-2 row that carried no trigger. */
  trigger?: TurnTrigger;
  stopReason?: StopReason | 'error';
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  usage?: Usage | null;
  cost?: number | null;
  /** Context window, from the turn's last `usage_update`. */
  contextUsed?: number;
  contextSize?: number;
}

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

/**
 * What the normalizer emits. `retract` exists for the fold rule (a short narration
 * bubble that becomes a work card's `lead`) and is honoured identically by the store
 * (row deleted), the WS frame and the SPA reducer.
 */
export type ItemPatch =
  | { op: 'upsert'; item: ChatItem }
  | { op: 'retract'; itemId: string };

// --- Sessions --------------------------------------------------------------

export type ChatSessionState =
  | 'none'
  | 'spawning'
  | 'ready'
  | 'running'
  | 'idle'
  | 'stopped'
  | 'error';

/** The four-tier cwd resolution chain for chat sessions. */
export type CwdTier = 'worktree' | 'repository' | 'project' | 'home';

export type { ChatCommand, ChatCommandAction, ChatCommandsSource } from './commands.js';

/** Payload of the `chat-session` WS frame and of `GET …/chat/session`. */
export interface ChatSessionSummary {
  assignmentId: string;
  agentId: string;
  harness: Harness;
  acpSessionId: string | null;
  adapterVersion: string | null;
  state: ChatSessionState;
  model: string | null;
  mode: string | null;
  effort: string | null;
  lastTurnAt: string | null;
  cumulative: ModelTokens | null;
  /**
   * Queued (not yet sent) turns for this agent, oldest first. A human-triggered
   * entry is withdrawable — the SPA reads its `messageId` off the trigger.
   */
  queued: Array<{ text: string; trigger: TurnTrigger }>;
  /** Highest chat-level `seq` this session has been shown (Decision 4). */
  lastDeliveredSeq: number;
  /** Set when the session cannot run (no valid cwd, adapter missing, …). */
  error?: string | null;
  /** Resolved working directory for this session. */
  cwd?: string | null;
  /** Which tier of the resolution chain produced the cwd. */
  cwdTier?: CwdTier | null;
  /** Harness slash commands advertised for this session. */
  commands: import('./commands.js').ChatCommand[];
  /** Where {@link commands} came from — live session or per-harness cache. */
  commandsSource: import('./commands.js').ChatCommandsSource | null;
  /** True when the on-disk definition changed but a running turn still uses the old pins. */
  staleDefinition?: boolean;
}

/**
 * The per-assignment participant set — `<assignmentDir>/chat/participants.json`
 * (Decision 1). Ids are always filtered to definitions that still exist.
 */
export interface Participants {
  agents: string[];
  defaultAgent: string | null;
  /** Agent-to-agent hops allowed per chain; defaults to 4. */
  hopBudget?: number;
}

/** Named colours accepted by the agent-definition loader and editor. */
export type AgentColor = 'violet' | 'emerald' | 'amber' | 'sky' | 'rose' | 'slate';

/** What `GET /chat/agents` and the participants routes report per definition. */
export interface ChatAgentSummary {
  id: string;
  name: string;
  color: AgentColor;
  harness: Harness;
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
  /** True when `source` is null (a builtin, not a file). */
  builtin: boolean;
  /** True when a file overrides a builtin with the same id. */
  overridesBuiltin: boolean;
  /** The install hint when the adapter is not on PATH; null when it is. */
  missing: string | null;
}

// --- Session profile (§5.11) ----------------------------------------------

export type Inherit = { kind: 'inherit' };
export type Pinned<T> = { kind: 'pinned'; value: T };
export type ProfileField<T> = Inherit | Pinned<T>;

export const INHERIT: Inherit = { kind: 'inherit' };
export function pin<T>(value: T): Pinned<T> {
  return { kind: 'pinned', value };
}

/**
 * The one place session policy lives. Every field defaults to `inherit` — a chat
 * session gets exactly what the same agent would get launched by hand in the
 * worktree (§5.11) — and only pinned fields are applied.
 */
export interface SessionProfile {
  mode: ProfileField<string>;
  model: ProfileField<string>;
  effort: ProfileField<string>;
  settingSources: ProfileField<string[]>;
  mcpServers: ProfileField<string[]>;
  env: ProfileField<Record<string, string>>;
}

// --- Agent definitions and harness catalog (§5.4) --------------------------

export type RespondsTo = 'mentions' | 'all-human' | 'none';

export type AgentPermissions = 'ask' | 'auto';

export const AGENT_PERMISSIONS: readonly AgentPermissions[] = ['ask', 'auto'];

export interface AgentDefinition {
  id: string;
  name: string;
  color: AgentColor;
  harness: Harness;
  model?: string;
  /** A role name (`edits` | `ask` | `plan`) or a raw adapter mode id. */
  mode?: string;
  /**
   * `auto`: Syntaur answers every permission request with the most permissive
   * allow option, on every harness; cursor has no adapter-side bypass, so this
   * is the only one.
   */
  permissions: AgentPermissions;
  effort?: string;
  mcpServers?: string[];
  env?: Record<string, string>;
  respondsTo: RespondsTo;
  default: boolean;
  /** One line for the roster the other agents see in their `<context>`. */
  description?: string;
  /** An emoji or one to two characters; the name's initial when unset. */
  avatar?: string;
  /** The definition body — the system prompt. */
  systemPrompt: string;
  /** True when the file has no body and the base prompt is in effect. */
  promptIsDefault?: boolean;
  /** Absolute path of the file this came from; null for builtins. */
  source: string | null;
}

/** Writable agent-definition fields (the dashboard form and write API). */
export interface AgentDefinitionInput {
  id: string;
  name: string;
  color: AgentColor;
  harness: Harness;
  model?: string;
  mode?: string;
  permissions?: AgentPermissions;
  effort?: string;
  mcpServers?: string[];
  env?: Record<string, string>;
  respondsTo: RespondsTo;
  default: boolean;
  description?: string;
  avatar?: string;
  /** Empty string means no body (the base prompt applies). */
  systemPrompt: string;
}

/** The three role names a definition may use for `mode`, mapped per harness. */
export interface HarnessModeIds {
  edits: string;
  ask: string;
  plan: string;
  /**
   * The harness's most permissive mode — approvals are not asked for. claude
   * and codex each have a true one; cursor does not, so it maps to the same id
   * as `edits` (see the catalog).
   */
  bypass: string;
}

export type HarnessUsageSpec =
  | { kind: 'adapter-cost'; basis: 'cumulative' | 'per-turn' }
  | { kind: 'tokens' }
  | { kind: 'none' };

export interface HarnessOptionChoice {
  value: string;
  name: string;
  description: string | null;
}

export interface HarnessOption {
  id: string;
  name: string;
  category: string | null;
  currentValue: string | null;
  choices: HarnessOptionChoice[];
}

export type HarnessModes =
  | {
      currentModeId: string;
      available: Array<{ id: string; name: string; description: string | null }>;
    }
  | null;

export interface HarnessOptionsRecord {
  harness: Harness;
  adapterVersion: string | null;
  capturedAt: string;
  options: HarnessOption[];
  modes: HarnessModes;
}

export interface HarnessAuthState {
  state: 'ok' | 'failed' | 'unknown';
  detail: string | null;
  at: string | null;
}

export interface ChatHarnessSummary {
  id: Harness;
  label: string;
  command: string;
  args: string[];
  installed: string | null;
  installHint: string;
  modelConfigId: string;
  effortConfigId: string | null;
  roleModes: HarnessModeIds;
  systemPromptTransport: 'meta' | 'prompt';
  options: HarnessOptionsRecord | null;
  auth: HarnessAuthState;
}

export interface AgentTestResult {
  ok: boolean;
  reply: string | null;
  stopReason: string | null;
  model: string | null;
  mode: string | null;
  effort: string | null;
  profileErrors: string[];
  durationMs: number;
  error: string | null;
}

export interface HarnessSpec {
  id: Harness;
  label: string;
  command: string;
  args: string[];
  /** `meta` = `_meta.systemPrompt.append` on `session/new`; `prompt` = a `<system>` block. */
  systemPromptTransport: 'meta' | 'prompt';
  configIds: { model: string; effort?: string };
  modeIds: HarnessModeIds;
  /** How a broker restart reattaches when a previous `acpSessionId` exists. */
  reattach: 'resume' | 'load';
  usage: HarnessUsageSpec;
  installHint: string;
  /** Run only to explain a failed `initialize`, never as a gate. */
  authProbe: { command: string; args: string[] };
}

// --- Persistence -----------------------------------------------------------

export interface ChatSessionRow {
  session_key: string;
  assignment_id: string;
  project_slug: string | null;
  assignment_slug: string | null;
  agent_id: string;
  harness: string;
  acp_session_id: string | null;
  adapter_version: string | null;
  cwd: string | null;
  pid: number | null;
  profile_json: string | null;
  usage_snapshot_json: string | null;
  state: string;
  created_at: string;
  last_turn_at: string | null;
  last_delivered_seq: number;
  commands_json: string | null;
  standing_fingerprint: string | null;
}

export interface ChatItemRow {
  item_id: string;
  assignment_id: string;
  session_key: string;
  turn_id: string | null;
  agent_id: string;
  type: string;
  ts: string;
  seq_first: number;
  seq_last: number;
  sealed: number;
  json: string;
}

// --- WS frames -------------------------------------------------------------

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

export interface ChatAgentsFrame {
  agents: ChatAgentSummary[];
}

export type ChatWsFrame = ChatItemFrame | ChatSessionFrame | ChatParticipantsFrame | ChatAgentsFrame;

/** Re-exported so callers need not import the SDK for prompt building. */
export type { ContentBlock };
