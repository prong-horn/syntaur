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

export type Harness = 'claude' | 'codex';

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
  | 'turn.start'
  | 'turn.end'
  | 'turn.cancel'
  | 'acp.update'
  | 'acp.permission_request'
  | 'acp.permission_response'
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

/** `user.message` payload — `messageId` is minted at queue time and is what DELETE targets. */
export interface UserMessagePayload {
  messageId: string;
  text: string;
}

/** `turn.start` payload. */
export interface TurnStartPayload {
  messageId: string;
  startedAt: string;
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
  /** Null for items outside a turn (adapter notices, replay, session lifecycle). */
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
}

export interface TurnStatusItem extends ChatItemBase {
  type: 'turn.status';
  state: 'running' | 'ended';
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
  | AgentMessageItem
  | AgentThoughtItem
  | AgentWorkItem
  | AgentPlanItem
  | PermissionRequestItem
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
  /** Queued (not yet sent) user messages, oldest first. */
  queued: Array<{ messageId: string; text: string }>;
  /** Set when the session cannot run (no valid cwd, adapter missing, …). */
  error?: string | null;
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

export interface AgentDefinition {
  id: string;
  name: string;
  color: string;
  harness: Harness;
  model?: string;
  /** A role name (`edits` | `ask` | `plan`) or a raw adapter mode id. */
  mode?: string;
  effort?: string;
  mcpServers?: string[];
  env?: Record<string, string>;
  respondsTo: RespondsTo;
  default: boolean;
  /** The definition body — the system prompt. */
  systemPrompt: string;
  /** Absolute path of the file this came from; null for builtins. */
  source: string | null;
}

/** The three role names a definition may use for `mode`, mapped per harness. */
export interface HarnessModeIds {
  edits: string;
  ask: string;
  plan: string;
}

export interface HarnessSpec {
  id: Harness;
  label: string;
  command: string;
  args: string[];
  /** `meta` = `_meta.systemPrompt.append` on `session/new`; `prompt` = a `<system>` block. */
  systemPromptTransport: 'meta' | 'prompt';
  configIds: { model: string; effort: string };
  modeIds: HarnessModeIds;
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

export type ChatWsFrame = ChatItemFrame | ChatSessionFrame;

/** Re-exported so callers need not import the SDK for prompt building. */
export type { ContentBlock };
