/**
 * The session broker — one ACP client per (ticket, agent), and the only
 * thing in Syntaur that owns an agent process.
 *
 * The rules it enforces, all settled by the spike:
 *
 *  - **One in-flight `session/prompt` per session, and never steering**
 *    (Decision 6 / spike Decision 6). Row 13 loses a request on both adapters:
 *    claude's steered prompt never resolves, and codex merges a second prompt
 *    into the running turn and orphans the first. So the queue is Syntaur's: a
 *    message sent during a turn is persisted as `queued`, can be withdrawn, and
 *    is sent only after the current response resolves. "Interrupt" is
 *    `session/cancel`, which resolves the prompt in ~11–19 ms either way.
 *  - **Lazy spawn, `session/resume` to re-attach** (spike Decisions 7 and 8).
 *    The adapter is spawned on the first message, from the dashboard server,
 *    `detached`, with `cwd` = the ticket worktree; a dashboard restart takes
 *    it with it (stdin EOF), and the next message resumes the ACP session. A
 *    failed resume falls back to `session/new` plus a `system` row and re-sends
 *    the standing context.
 *  - **Standing context once per adapter session** (§2.4). Later turns carry
 *    only the new user message; after a resume the agent still holds it.
 *  - **Engagement snapshots are built here, not read from the collector**
 *    (Decision 10). Ticket cost is the per-model `cost` delta between an
 *    engagement's open and close snapshots, and the collector runs on its own
 *    schedule — a snapshot taken at turn close would usually predate the turn it
 *    closes. Both adapters return per-turn token buckets on `PromptResponse.usage`;
 *    claude additionally reports the session's CUMULATIVE cost on `usage_update`,
 *    so the broker stores that figure absolutely and a turn's own cost is the
 *    delta across it (Decision 11). Every turn is therefore a priced window.
 *  - **A crash is repaired on the next load, from the event log** (Decision 12).
 *    A SIGKILL leaves a `turn.start` with no `turn.end`, an engagement with no
 *    `ended_at`, and queued messages that were never sent. `repairSession` seals,
 *    closes and rehydrates all three before the first `drive`.
 *
 * Idle teardown is a requirement, not a nicety: a claude adapter group is
 * ~620 MB with the user's MCP servers forked into it (RESULTS.md row 19).
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';
import type * as acp from '@agentclientprotocol/sdk';
import type { ResolvedTicket } from '../utils/ticket-resolver.js';
import { extractFrontmatter, getNestedField } from '../dashboard/parser.js';
import { resolveChatCwd, type CwdTier } from './chat-cwd.js';
import { syntaurRoot } from '../utils/paths.js';
import { appendComment } from '../lifecycle/comment-append.js';
import { resolveQuestionComments } from '../lifecycle/comment-resolve.js';
import { appendProgressLog, ticketHasLogRole } from '../lifecycle/progress-append.js';
import { type ParsedComment } from '../dashboard/parser.js';
import {
  detectOpenQuestion,
  formatChatQuestionMarker,
  parseChatQuestionMarker,
  questionBodyForCard,
} from './questions.js';
import { buildTurnProgressEntry, fileChatRecord } from './records.js';
import { appendSession, updateSessionStatus } from '../dashboard/agent-sessions.js';
import {
  closeEngagementById,
  closeOpenEngagement,
  getOpenEngagement,
  openEngagement,
} from '../db/engagement-db.js';
import type { ModelTokens, TokenSnapshot } from '../db/engagement-tokens.js';
import { upsertEvent } from '../db/usage-db.js';
import { priceForModel } from '../usage/pricing.js';
import {
  applyChatPatch,
  clearChatSessionPid,
  deleteChatSession,
  deleteChatSessionsForAgent,
  findChatItemByRequestId,
  getChatItem,
  getChatSession,
  getHarnessOptions,
  latestHarnessCommands,
  listChatItems,
  listChatItemsByTurn,
  listChatItemsSince,
  listChatSessions,
  setHarnessAuth,
  setHarnessCommands,
  upsertChatSession,
  upsertHarnessOptions,
} from '../db/chat-db.js';
import { adapterVersion as readAdapterVersion, spawnAcpClient, type AcpClient } from './acp-client.js';
import { commandsEqual, detectCommand, latestAdvertisedCommands, parseAvailableCommands, type ChatCommand, type ChatCommandsSource } from './commands.js';
import {
  assertWritableAgentId,
  deleteAgentDefinition,
  loadAgentDefinitions,
  resolveAgent,
  toAgentSummary,
  writeAgentDefinition,
  AgentDefinitionError,
  AgentWriteError,
  type LoadAgentDefinitionsResult,
} from './agents.js';
import { readParticipants, readParticipantsDetailed, writeParticipants } from './participants.js';
import { DEFAULT_HOP_BUDGET, parseMentions, routeAgentReply, routeHuman } from './router.js';
import { HARNESSES, HARNESS_IDS, probeAuth, resolveCommand, type CommandResolution } from './harnesses.js';
import { parseHarnessOptions } from './harness-options.js';
import { ChatNormalizer, blockText } from './normalizer.js';
import { applyProfile, inheritedProfile, newSessionMeta, profileEnv, profileForTier, resolveSessionProfile, serializeProfile } from './profile.js';
import { textBlock } from './prompt-framing.js';
import {
  buildCommandPrompt,
  buildStandingContext,
  buildTurnPrompt,
  selectChatHistory,
  standingFingerprint,
  readTicketStandingMeta,
  agentStandingInputsChanged,
  type TurnPromptTrigger,
} from './prompt-framing.js';
import { openChatLog, type ChatLog } from './store.js';
import { readChatAttachmentBase64 } from './attachments.js';
import { HUMAN_AGENT_ID, SYSTEM_AGENT_ID } from './types.js';
import type {
  AgentDefinition,
  AgentDefinitionInput,
  AgentMessageItem,
  AgentTestResult,
  ChatAgentSummary,
  ChatAttachment,
  ChatEvent,
  ChatHarnessSummary,
  ChatEventKind,
  HandoffPayload,
  PermissionRequestPayload,
  PermissionResponsePayload,
  QuestionAnsweredPayload,
  AcpExtPayload,
  TurnStartPayload,
  TurnTrigger,
  ChatQuestionKind,
  ChatQuestionRef,
  HandoffItem,
  UserMessageItem,
  UserMessagePayload,
  ChatItem,
  ChatSessionState,
  ChatSessionSummary,
  ContentBlock,
  FileChatRecordInput,
  FiledChatRecord,
  Harness,
  HarnessSpec,
  ItemPatch,
  Participants,
  SessionProfile,
  SessionRotatedPayload,
} from './types.js';

// --- knobs -----------------------------------------------------------------

export interface BrokerTimeouts {
  /** How long a pending permission waits before it is rejected and filed (Decision 9). */
  permissionMs: number;
  /** How long a parked card waits before an Inbox question is filed (Decision 3). */
  inboxGraceMs: number;
  /** No `session/update` for this long during a turn → cancel. claude thinks silently for 25 s. */
  turnIdleMs: number;
  /** Hard cap on one turn. */
  turnMaxMs: number;
  /** Tear the adapter down this long after the last turn (~620 MB per claude group). */
  sessionIdleMs: number;
  /** Coalescing window for `chat-item` frames; codex streams ~36 chunks/s. */
  flushMs: number;
  /** How long `stopAll` waits for a cancelled prompt to resolve. */
  shutdownGraceMs: number;
  /** Cap on throwaway harness refresh and agent test prompts. */
  throwawayMs: number;
  /** How long a Refresh waits for `available_commands_update` after `session/new`. */
  throwawayCommandsMs: number;
}

export const DEFAULT_TIMEOUTS: BrokerTimeouts = {
  inboxGraceMs: 30_000,
  permissionMs: 5 * 60_000,
  turnIdleMs: 10 * 60_000,
  turnMaxMs: 60 * 60_000,
  sessionIdleMs: 10 * 60_000,
  flushMs: 50,
  shutdownGraceMs: 2_000,
  throwawayMs: 60_000,
  throwawayCommandsMs: 3_000,
};

export interface ClientFactoryInput {
  /** Which agent definition this adapter is being spawned for. */
  agentId: string;
  harness: HarnessSpec;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  onUpdate: (notification: acp.SessionNotification) => void;
  onPermissionRequest: (request: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>;
  onExtRequest?: (method: string, params: unknown) => Promise<unknown>;
  onExtNotification?: (method: string, params: unknown) => void;
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
}

export type ClientFactory = (input: ClientFactoryInput) => AcpClient;

export interface BrokerBroadcast {
  (message: {
    type: 'chat-item' | 'chat-session' | 'chat-participants' | 'chat-agents';
    projectSlug?: string | null;
    ticketSlug?: string;
    timestamp: string;
    payload: unknown;
  }): void;
}

export interface CreateChatBrokerOptions {
  projectsDir: string;
  broadcast: BrokerBroadcast;
  /** Injected by tests to wire an in-process fake agent instead of a subprocess. */
  clientFactory?: ClientFactory;
  /** Injected by tests; defaults to the machine's `~/.syntaur`. */
  syntaurHome?: string;
  /** Injected by tests so spawn/auth does not depend on adapters on PATH. */
  commandResolver?: (spec: HarnessSpec) => CommandResolution;
  authProber?: (spec: HarnessSpec) => string;
  clock?: { now(): number };
  timeouts?: Partial<BrokerTimeouts>;
  /** Routing knobs; `participants.json` overrides `hopBudget` per ticket. */
  routing?: { hopBudget?: number };
  /** Injected by tests; defaults to `loadAgentDefinitions`. */
  loadDefinitions?: (root: string) => Promise<LoadAgentDefinitionsResult>;
}

/** A send that cannot proceed — the router turns this into an HTTP 409. */
export class ChatSendError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = 'ChatSendError';
  }
}

export interface ChatBroker {
  send(input: {
    ticket: ResolvedTicket;
    agentId?: string | null;
    text: string;
    attachments?: ChatAttachment[];
  }): Promise<{
    messageId: string;
  }>;
  withdraw(ticket: ResolvedTicket, messageId: string): Promise<boolean>;
  cancel(ticket: ResolvedTicket, agentId?: string | null): Promise<boolean>;
  answerPermission(
    ticket: ResolvedTicket,
    requestId: string,
    optionId: string,
    opts?: { allowAllSession?: boolean },
  ): Promise<boolean>;
  answerQuestion(
    ticket: ResolvedTicket,
    requestId: string,
    answer: { optionId?: string; text?: string },
  ): Promise<boolean>;
  getSession(
    ticket: ResolvedTicket,
    agentId?: string | null,
  ): Promise<ChatSessionSummary | null>;
  listAgents(): Promise<{ definitions: AgentDefinition[]; errors: string[] }>;
  harnesses(): ChatHarnessSummary[];
  refreshHarness(id: Harness): Promise<ChatHarnessSummary>;
  testAgent(id: string): Promise<AgentTestResult>;
  saveAgent(input: AgentDefinitionInput): Promise<AgentDefinition>;
  deleteAgent(id: string): Promise<{ restoredBuiltin: boolean }>;
  agentSummaries(): Promise<ChatAgentSummary[]>;
  /** The ticket's attached agents, default and hop budget (Decision 1). */
  getParticipants(
    ticket: ResolvedTicket,
  ): Promise<{ participants: Participants; agents: ChatAgentSummary[] }>;
  /** Validate, persist and broadcast a new participant set. */
  setParticipants(
    ticket: ResolvedTicket,
    next: Participants,
  ): Promise<{ participants: Participants; agents: ChatAgentSummary[] }>;
  items(ticket: ResolvedTicket, opts: { beforeSeq?: number; limit?: number }): ChatItem[];
  fileRecord(
    ticket: ResolvedTicket,
    itemId: string,
    record: FileChatRecordInput,
  ): Promise<FiledChatRecord>;
  reindex(ticket: ResolvedTicket): Promise<{ events: number; items: number }>;
  stopAll(): Promise<void>;
}

// --- internals -------------------------------------------------------------

interface InFlightTurn {
  turnId: string;
  /** What this turn is answering — a human message or a handoff hop. */
  trigger: TurnTrigger;
  startedAt: string;
  startedMs: number;
  engagementId: number;
  engagementStartedAt: string;
  /**
   * The session's CUMULATIVE cost as last reported by `usage_update`
   * (claude only). The turn's own cost is this minus {@link costAtOpen}.
   */
  reportedCumulativeCost: number | null;
  /** The session's cumulative cost when this turn started. */
  costAtOpen: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  maxTimer: ReturnType<typeof setTimeout> | null;
  cancelled: boolean;
  /**
   * The highest chat-level `seq` this turn's prompt actually carried. The cursor
   * is two-phase (Decision 4): computed when the prompt is built, committed at
   * `turn.end` for every stop reason but `error`, so a failed prompt re-delivers.
   */
  deliveredSeqCandidate: number | null;
}

interface PendingPermission {
  resolve: (response: acp.RequestPermissionResponse) => void;
  timer: ReturnType<typeof setTimeout>;
  title: string;
  options: acp.PermissionOption[];
  graceTimer: ReturnType<typeof setTimeout> | null;
  inboxCommentId: string | null;
  recorded: Promise<void>;
}

interface PendingQuestion {
  resolve: (response: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  toolCallId: string;
  questions: Array<{
    id: string;
    prompt: string;
    options?: Array<{ id: string; label: string }>;
    allowMultiple?: boolean;
  }>;
  graceTimer: ReturnType<typeof setTimeout> | null;
  inboxCommentId: string | null;
  recorded: Promise<void>;
}

interface Session {
  key: string;
  ticket: ResolvedTicket;
  agentId: string;
  definition: AgentDefinition;
  harness: HarnessSpec;
  profile: SessionProfile;
  log: ChatLog;
  normalizer: ChatNormalizer;
  client: AcpClient | null;
  capabilities: acp.AgentCapabilities | null;
  acpSessionId: string | null;
  adapterVersion: string | null;
  cwd: string | null;
  cwdTier: CwdTier | null;
  branch: string | null;
  model: string | null;
  mode: string | null;
  effort: string | null;
  state: ChatSessionState;
  standingSent: boolean;
  /** Bumped on every standing invalidation; guards post-prompt commits. */
  standingGen: number;
  /** Persisted sha256 of the last standing block this adapter session was shown. */
  standingFingerprint: string | null;
  queue: Array<{ text: string; trigger: TurnTrigger; attachments?: ChatAttachment[] }>;
  /** Highest chat-level `seq` this session has been shown (Decision 4). */
  lastDeliveredSeq: number;
  /**
   * The hop budget in force when this session was last routed to. Only the
   * prompt's "Hop n of B" line reads it; the router always re-reads
   * `participants.json`, which is the authority.
   */
  hopBudget: number;
  inFlight: InFlightTurn | null;
  pendingPermissions: Map<string, PendingPermission>;
  pendingQuestions: Map<string, PendingQuestion>;
  permissionSeq: number;
  questionSeq: number;
  /** While `session/load` replays history, content updates are dropped. */
  loading: boolean;
  cumulative: TokenSnapshot;
  /** One "no rate for <model>" notice per session, not one per turn. */
  unpricedNoticeSent: boolean;
  lastTurnAt: string | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  pendingPatches: Map<string, ItemPatch>;
  error: string | null;
  /** Harness slash commands last advertised for this session. */
  commands: ChatCommand[];
  commandsSource: ChatCommandsSource | null;
  /** Serialises `drive` so two sends cannot both spawn an adapter. */
  driving: Promise<void>;
  /** Bumped when the on-disk definition changes; live sessions re-read on next open. */
  definitionStale: boolean;
  /** Set when a stale apply should warn that the system prompt needs a new session. */
  stalePromptChanged: boolean;
  /** `definitionsRev` at construction start — detects mid-build saves. */
  builtAtRev: number;
  /** Auto-answer later permission requests for this session (not persisted). */
  autoApprove: boolean;
}

/** Probe value for "is this model in the price list at all?". */
const ZERO_BUCKETS = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

const EMPTY_TOKENS: ModelTokens = {
  input: 0,
  output: 0,
  cacheCreation: 0,
  cacheRead: 0,
  total: 0,
  cost: 0,
};

/**
 * The scope routing-level rows are written under (Decision 3). A fan-out user
 * message, a `handoff` and a routing notice belong to no agent session, so they
 * get a session key of their own — one the SPA never asks about and
 * `rebuildChatIndex` treats like any other.
 */
export function ticketScopeKey(ticketId: string): string {
  return `${ticketId}~@ticket`;
}

/** Agent session key: `<ID>~<harness>`. */
export function chatSessionKey(ticketId: string, harness: string): string {
  return `${ticketId}~${harness}`;
}

/** The ticket scope's live normalizer, plus what the broker reads back. */
interface TicketScope {
  key: string;
  log: ChatLog;
  normalizer: ChatNormalizer;
  /** `messageId` → the routed user message, for `withdraw`'s delivery check. */
  messages: Map<string, UserMessageItem>;
  /** `handoffId` → the row, so a hop's prompt can exclude its own trigger. */
  handoffs: Map<string, HandoffItem>;
}

export function createChatBroker(options: CreateChatBrokerOptions): ChatBroker {
  const timeouts: BrokerTimeouts = { ...DEFAULT_TIMEOUTS, ...(options.timeouts ?? {}) };
  const commandResolver = options.commandResolver ?? resolveCommand;
  const authProber = options.authProber ?? probeAuth;
  const now = () => (options.clock ? options.clock.now() : Date.now());
  const iso = () => new Date(now()).toISOString();
  const sessions = new Map<string, Session>();
  /**
   * Sessions still being built. `ensureSession` must not publish into
   * `sessions` until `repairSession` has finished, or a concurrent `send` from
   * another tab can take the half-repaired session and `drive` it — opening an
   * engagement against an unsealed orphan, or letting `registerAgentSession`
   * absorb the dangling engagement as `chat-registered` again (round 2,
   * finding 1). Caching the in-flight promise keeps two concurrent calls for
   * the same key sharing ONE construction and ONE repair, the same shape as
   * `logs` below.
   */
  const constructing = new Map<string, Promise<Session>>();
  /**
   * One `ChatLog` per ticket DIRECTORY, not per session (finding 4). Every
   * agent on a ticket appends to the same `events.jsonl`, and each log
   * instance owns its own `seq` counter and append chain — two instances would
   * hand out duplicate `seq` values and interleave torn lines. The promise is
   * cached (not the resolved log) so concurrent `ensureSession` calls await the
   * same open rather than racing to create two.
   */
  const logs = new Map<string, Promise<ChatLog>>();
  /** One ticket scope per ticket directory (Decision 3). */
  const ticketScopes = new Map<string, Promise<TicketScope>>();
  /** Serialize record writes per ticket directory (Decision 3). */
  const recordChains = new Map<string, Promise<void>>();
  const clientFactory: ClientFactory = options.clientFactory ?? defaultClientFactory;
  let stopping = false;
  const refreshing = new Map<Harness, Promise<ChatHarnessSummary>>();
  const testing = new Map<string, Promise<AgentTestResult>>();
  let definitionsRev = 0;
  /** Agents being deleted — checked synchronously so in-flight construction aborts. */
  const pendingAgentDeletes = new Set<string>();
  let agentWrites: Promise<unknown> = Promise.resolve();

  const TEST_PROMPT =
    'This is a connection test from Syntaur. Reply with the single word OK and nothing else. Do not use tools.';
  const loadDefinitions = options.loadDefinitions ?? loadAgentDefinitions;
  const syntaurHome = () => options.syntaurHome ?? syntaurRoot();
  const loadDefs = (): Promise<LoadAgentDefinitionsResult> => loadDefinitions(syntaurHome());

  function withRecordLock<T>(ticketDir: string, fn: () => Promise<T>): Promise<T> {
    const prev = recordChains.get(ticketDir) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(fn);
    recordChains.set(ticketDir, next.then(() => {}, () => {}));
    return next;
  }

  async function writeTurnProgress(
    session: Session,
    turn: InFlightTurn,
    durationMs: number,
  ): Promise<void> {
    try {
      const items = listChatItemsByTurn(session.ticket.id, turn.turnId);
      const text = buildTurnProgressEntry({
        agentId: session.agentId,
        durationMs,
        items,
        cwd: session.cwd,
        turnId: turn.turnId,
      });
      if (!text) return;
      if (!(await ticketHasLogRole(session.ticket.ticketDir))) return;
      await withRecordLock(session.ticket.ticketDir, () =>
        appendProgressLog({
          ticketDir: session.ticket.ticketDir,
          ticketRef: session.ticket.ticketSlug,
          text,
          author: session.agentId,
        }),
      );
    } catch (err) {
      try {
        await record(
          session,
          'system',
          { level: 'warn', text: `Could not write the progress entry: ${(err as Error).message}` },
          turn.turnId,
        );
        flush(session);
      } catch {
        // Never let a progress-write failure propagate into finishTurn.
      }
    }
  }

  function byCommentId(id: string): (c: ParsedComment) => boolean {
    return (c) => c.id === id;
  }

  function byAgentAndKind(agentId: string, kinds: ChatQuestionKind[]): (c: ParsedComment) => boolean {
    const kindSet = new Set(kinds);
    return (c) => {
      if (c.author !== agentId || c.type !== 'question' || c.resolved === true) return false;
      const { ref } = parseChatQuestionMarker(c.body);
      return ref !== null && kindSet.has(ref.kind);
    };
  }

  function byKindAndItemIds(kind: ChatQuestionKind, itemIds: string[]): (c: ParsedComment) => boolean {
    const idSet = new Set(itemIds);
    return (c) => {
      if (c.type !== 'question' || c.resolved === true) return false;
      const { ref } = parseChatQuestionMarker(c.body);
      return ref !== null && ref.kind === kind && idSet.has(ref.itemId);
    };
  }

  async function fileChatQuestion(
    session: Session,
    ref: ChatQuestionRef,
    text: string,
  ): Promise<string | null> {
    try {
      return await withRecordLock(session.ticket.ticketDir, () =>
        appendComment({
          ticketDir: session.ticket.ticketDir,
          ticketRef: session.ticket.ticketSlug,
          author: session.agentId,
          type: 'question',
          body: `${text}\n\n${formatChatQuestionMarker(ref)}`,
        }),
      );
    } catch (err) {
      try {
        await record(
          session,
          'system',
          { level: 'warn', text: `Could not file the Inbox question: ${(err as Error).message}` },
        );
      } catch {
        /* swallow */
      }
      return null;
    }
  }

  async function resolveChatQuestions(
    target: Session | ResolvedTicket,
    predicate: (c: ParsedComment) => boolean,
  ): Promise<void> {
    const ticketDir = 'ticket' in target ? target.ticket.ticketDir : target.ticketDir;
    const session = 'ticket' in target ? target : null;
    try {
      await withRecordLock(ticketDir, () => resolveQuestionComments(ticketDir, predicate));
    } catch (err) {
      if (session) {
        try {
          await record(session, 'system', {
            level: 'warn',
            text: `Could not resolve the Inbox question: ${(err as Error).message}`,
          });
        } catch {
          /* swallow */
        }
      }
    }
  }

  async function settlePendingCard(
    session: Session,
    pending: PendingPermission | PendingQuestion,
  ): Promise<void> {
    if (pending.graceTimer) {
      clearTimeout(pending.graceTimer);
      pending.graceTimer = null;
    }
    if (pending.inboxCommentId) {
      const commentId = pending.inboxCommentId;
      pending.inboxCommentId = null;
      await resolveChatQuestions(session, byCommentId(commentId));
    }
  }

  function armCardGraceTimer(
    session: Session,
    requestId: string,
    kind: 'permission' | 'ask',
    titleOrPrompt: string,
    pending: PendingPermission | PendingQuestion,
  ): void {
    const graceTimer = setTimeout(() => {
      void (async () => {
        const stillPending =
          session.pendingPermissions.get(requestId) === pending ||
          session.pendingQuestions.get(requestId) === pending;
        if (!stillPending) return;
        await pending.recorded;
        const item = findChatItemByRequestId(session.ticket.id, requestId);
        const ref: ChatQuestionRef = { kind, itemId: item?.itemId ?? requestId };
        const commentId = await fileChatQuestion(
          session,
          ref,
          questionBodyForCard(kind, titleOrPrompt),
        );
        if (!commentId) return;
        const stillThere =
          session.pendingPermissions.get(requestId) === pending ||
          session.pendingQuestions.get(requestId) === pending;
        if (!stillThere) {
          await resolveChatQuestions(session, byCommentId(commentId));
        } else {
          pending.inboxCommentId = commentId;
        }
      })();
    }, timeouts.inboxGraceMs);
    graceTimer.unref?.();
    pending.graceTimer = graceTimer;
  }

  async function agentSummaries(): Promise<ChatAgentSummary[]> {
    const { definitions } = await loadDefs();
    return definitions.map((d) => toAgentSummary(d, commandResolver));
  }

  async function broadcastAgents(): Promise<void> {
    options.broadcast({
      type: 'chat-agents',
      projectSlug: null,
      timestamp: iso(),
      payload: { agents: await agentSummaries() },
    });
  }

  function definitionFingerprint(def: AgentDefinition): string {
    return JSON.stringify({
      name: def.name,
      color: def.color,
      harness: def.harness,
      model: def.model ?? null,
      mode: def.mode ?? null,
      effort: def.effort ?? null,
      mcpServers: def.mcpServers ?? null,
      env: def.env ?? null,
      respondsTo: def.respondsTo,
      default: def.default,
      description: def.description ?? null,
      avatar: def.avatar ?? null,
      systemPrompt: def.systemPrompt,
      promptIsDefault: def.promptIsDefault ?? false,
      permissions: def.permissions,
    });
  }

  function definitionChanged(a: AgentDefinition, b: AgentDefinition): boolean {
    return definitionFingerprint(a) !== definitionFingerprint(b);
  }

  function participantAgentsChanged(before: readonly string[], after: readonly string[]): boolean {
    if (before.length !== after.length) return true;
    const afterSet = new Set(after);
    return before.some((id) => !afterSet.has(id));
  }

  /** Standing context is per-session; roster edits must refresh every agent in the room. */
  async function invalidateStandingForParticipant(agentId: string): Promise<void> {
    const { definitions } = await loadDefs();
    const ticketsToInvalidate = new Set<string>();
    for (const session of sessions.values()) {
      const { participants } = await readParticipantsDetailed(
        session.ticket.ticketDir,
        definitions,
      );
      if (participants.agents.includes(agentId)) {
        ticketsToInvalidate.add(session.ticket.id);
      }
    }
    for (const session of sessions.values()) {
      if (ticketsToInvalidate.has(session.ticket.id)) {
        invalidateStanding(session);
      }
    }
  }

  /** Invalidate standing and bump the generation so in-flight commits are dropped. */
  function invalidateStanding(session: Session): void {
    session.standingGen += 1;
    session.standingSent = false;
  }

  function rosterPresentationChanged(
    before: AgentDefinition | undefined,
    after: AgentDefinition,
  ): boolean {
    return agentStandingInputsChanged(before, after);
  }

  async function repairDroppedParticipants(
    ticket: ResolvedTicket,
    dropped: string[],
    participants: Participants,
    definitions: readonly AgentDefinition[],
  ): Promise<Participants> {
    if (dropped.length === 0) return participants;
    const repaired = await writeParticipants(ticket.ticketDir, participants, definitions);
    for (const id of dropped) {
      await recordTicket(ticket,
        'system',
        {
          level: 'info',
          text: `@${id} is no longer in this chat — its agent definition no longer exists`,
        },
        { agentId: SYSTEM_AGENT_ID },
      );
    }
    options.broadcast({
      type: 'chat-participants',
      projectSlug: ticket.projectSlug,
      ticketSlug: ticket.ticketSlug,
          timestamp: iso(),
          payload: {
            ticketId: ticket.id,
        participants: repaired,
        agents: definitions.map((d) => toAgentSummary(d, commandResolver)),
      },
    });
    return repaired;
  }

  async function applyPins(session: Session, client: AcpClient, sessionId: string): Promise<void> {
    const profile = profileForTier(session.profile, session.cwdTier);
    const { applied, errors } = await applyProfile(client, sessionId, profile, session.harness);
    const parts: string[] = [];
    if (applied.mode) {
      session.mode = applied.mode;
      parts.push(`mode ${applied.mode}`);
    }
    if (applied.model) {
      session.model = applied.model;
      parts.push(`model ${applied.model}`);
    }
    if (applied.effort) {
      session.effort = applied.effort;
      parts.push(`effort ${applied.effort}`);
    }
    const detail = parts.length > 0 ? parts.join(', ') : 'no pinned fields';
    await record(
      session,
      'system',
      { level: 'info', text: `Applied @${session.agentId}'s updated definition: ${detail}` },
      null,
    );
    if (session.stalePromptChanged) {
      await record(
        session,
        'system',
        { level: 'warn', text: 'The new system prompt takes effect at the next new session' },
        null,
      );
      session.stalePromptChanged = false;
    }
    for (const error of errors) {
      await record(session, 'system', { level: 'warn', text: `Could not pin ${error}` }, null);
    }
    session.definitionStale = false;
    emitSession(session);
  }

  async function tearDownForHarnessChange(session: Session): Promise<void> {
    const dropped = session.queue.splice(0, session.queue.length);
    for (const entry of dropped) {
      await recordTicket(
        session.ticket,
        'route.notice',
        {
          level: 'warn',
          text:
            `@${session.agentId}'s harness changed — a queued message was withdrawn: ` +
            `${firstLineOf(entry.text)}`,
        },
        { agentId: SYSTEM_AGENT_ID },
      );
    }
    if (session.inFlight) {
      await cancelTurn(session).catch(() => false);
      await Promise.race([
        waitFor(() => session.inFlight === null, timeouts.shutdownGraceMs),
        sleep(timeouts.shutdownGraceMs),
      ]);
    }
    await shutdownSession(session);
    deleteChatSession(session.key);
    sessions.delete(session.key);
  }

  async function applyDefinitionToSessions(
    id: string,
    newDef: AgentDefinition,
    opts: { restoredBuiltin?: boolean } = {},
  ): Promise<void> {
    await Promise.allSettled(
      [...constructing.entries()]
        .filter(([key]) => key.endsWith(`~${id}`))
        .map(([, promise]) => promise),
    );

    const touchedTickets = new Map<string, ResolvedTicket>();
    for (const session of [...sessions.values()]) {
      if (session.agentId !== id) continue;
      touchedTickets.set(session.ticket.id, session.ticket);
      const prevPrompt = session.definition.systemPrompt;
      const harnessChanged = session.harness.id !== newDef.harness;
      session.definition = newDef;
      session.profile = resolveSessionProfile(newDef, HARNESSES[newDef.harness as Harness]);
      session.harness = HARNESSES[newDef.harness as Harness];
      session.definitionStale = true;
      session.stalePromptChanged = prevPrompt !== newDef.systemPrompt;

      if (harnessChanged) {
        if (opts.restoredBuiltin) {
          await record(
            session,
            'system',
            { level: 'info', text: `@${id} is back to its built-in definition` },
            null,
          );
        }
        await tearDownForHarnessChange(session);
        continue;
      }

      const clientAlive = session.client?.alive() ?? false;
      const idle = !session.inFlight && session.queue.length === 0;
      if (clientAlive && idle) {
        await shutdownSession(session);
      } else if (session.inFlight) {
        emitSession(session);
      }

      if (opts.restoredBuiltin) {
        await record(
          session,
          'system',
          { level: 'info', text: `@${id} is back to its built-in definition` },
          null,
        );
      }
    }

    if (opts.restoredBuiltin) {
      const { definitions } = await loadDefs();
      for (const ticket of touchedTickets.values()) {
        const participants = await readParticipants(ticket.ticketDir, definitions);
        options.broadcast({
          type: 'chat-participants',
          projectSlug: ticket.projectSlug,
          ticketSlug: ticket.ticketSlug,
          timestamp: iso(),
          payload: {
            ticketId: ticket.id,
            participants,
            agents: definitions.map((d) => toAgentSummary(d, commandResolver)),
          },
        });
      }
    }
  }

  function sharedLog(ticketDir: string): Promise<ChatLog> {
    let log = logs.get(ticketDir);
    if (!log) {
      log = openChatLog(ticketDir);
      logs.set(ticketDir, log);
    }
    return log;
  }

  /**
   * One ticket scope per ticket directory, cached like `sharedLog` and
   * for the same reason: its normalizer owns the per-scope ordinals that make
   * item ids stable, so two instances would hand out colliding ids. The cached
   * value is the PROMISE, so two concurrent callers share one replay.
   */
  function ticketScope(ticket: ResolvedTicket): Promise<TicketScope> {
    let pending = ticketScopes.get(ticket.ticketDir);
    if (!pending) {
      pending = (async () => {
        const log = await sharedLog(ticket.ticketDir);
        const key = ticketScopeKey(ticket.id);
        const scope: TicketScope = {
          key,
          log,
          normalizer: new ChatNormalizer({
            ticketId: ticket.id,
            agentId: SYSTEM_AGENT_ID,
            sessionKey: key,
          }),
          messages: new Map(),
          handoffs: new Map(),
        };
        // Pick up where the persisted log left off, so a restart does not
        // restart the ordinals and collide item ids.
        for (const event of await log.readAll()) {
          if (event.sessionKey !== key) continue;
          for (const patch of scope.normalizer.ingest(event)) noteScopeItem(scope, patch);
        }
        return scope;
      })();
      ticketScopes.set(ticket.ticketDir, pending);
    }
    return pending;
  }

  /** Keep the routed user messages to hand — `withdraw` needs `deliveredTo`. */
  function noteScopeItem(scope: TicketScope, patch: ItemPatch): void {
    if (patch.op !== 'upsert') return;
    if (patch.item.type === 'user.message') scope.messages.set(patch.item.messageId, patch.item);
    else if (patch.item.type === 'handoff') scope.handoffs.set(patch.item.handoffId, patch.item);
  }

  /**
   * Append a routing-level event to the ticket scope (Decision 3). No agent
   * session owns these rows, so there is no per-session flush window: each patch
   * is broadcast immediately.
   */
  async function recordTicket(
    ticket: ResolvedTicket,
    kind: ChatEventKind,
    payload: unknown,
    opts: { agentId: string; turnId?: string | null },
  ): Promise<ChatEvent> {
    const scope = await ticketScope(ticket);
    const event = await scope.log.append({
      ticketId: ticket.id,
      agentId: opts.agentId,
      sessionKey: scope.key,
      turnId: opts.turnId ?? null,
      kind,
      payload,
      ts: iso(),
    });
    for (const patch of scope.normalizer.ingest(event)) {
      noteScopeItem(scope, patch);
      applyChatPatch(scope.key, patch);
      options.broadcast({
        type: 'chat-item',
        projectSlug: ticket.projectSlug,
        ticketSlug: ticket.ticketSlug,
          timestamp: iso(),
          payload: {
            ticketId: ticket.id, patch },
      });
    }
    return event;
  }

  /** Definitions and the participant set, read together on every routing pass. */
  async function routingContext(ticket: ResolvedTicket) {
    const { definitions } = await loadDefs();
    const { participants: raw, dropped } = await readParticipantsDetailed(
      ticket.ticketDir,
      definitions,
    );
    const participants = await repairDroppedParticipants(
      ticket,
      dropped,
      raw,
      definitions,
    );
    const hopBudget = participants.hopBudget ?? options.routing?.hopBudget ?? DEFAULT_HOP_BUDGET;
    return { definitions, participants: { ...participants, hopBudget } };
  }

  // --- events, items, broadcast -------------------------------------------

  async function record(
    session: Session,
    kind: ChatEventKind,
    payload: unknown,
    turnId: string | null = session.inFlight?.turnId ?? null,
  ): Promise<void> {
    const event = await session.log.append({
      ticketId: session.ticket.id,
      agentId: session.agentId,
      sessionKey: session.key,
      turnId,
      kind,
      payload,
      ts: iso(),
    });
    for (const patch of session.normalizer.ingest(event)) {
      applyChatPatch(session.key, patch);
      queuePatch(session, patch);
    }
  }

  /**
   * Coalesce to one frame per item per flush window (Decision 3): the latest
   * state of an item wins, and a `retract` goes out immediately so the SPA never
   * renders a bubble the fold rule already removed.
   */
  function queuePatch(session: Session, patch: ItemPatch): void {
    if (patch.op === 'retract') {
      session.pendingPatches.delete(patch.itemId);
      emitPatch(session, patch);
      return;
    }
    session.pendingPatches.set(patch.item.itemId, patch);
    if (session.flushTimer) return;
    session.flushTimer = setTimeout(() => {
      session.flushTimer = null;
      flush(session);
    }, timeouts.flushMs);
    session.flushTimer.unref?.();
  }

  function flush(session: Session): void {
    const pending = [...session.pendingPatches.values()];
    session.pendingPatches.clear();
    for (const patch of pending) emitPatch(session, patch);
  }

  function emitPatch(session: Session, patch: ItemPatch): void {
    options.broadcast({
      type: 'chat-item',
      projectSlug: session.ticket.projectSlug,
      ticketSlug: session.ticket.ticketSlug,
      timestamp: iso(),
      payload: { ticketId: session.ticket.id, patch },
    });
  }

  function setState(session: Session, state: ChatSessionState, error?: string | null): void {
    session.state = state;
    if (error !== undefined) session.error = error;
    persistSession(session);
    emitSession(session);
  }

  function emitSession(session: Session): void {
    options.broadcast({
      type: 'chat-session',
      projectSlug: session.ticket.projectSlug,
      ticketSlug: session.ticket.ticketSlug,
      timestamp: iso(),
      payload: {
        ticketId: session.ticket.id,
        agentId: session.agentId,
        session: summarize(session),
      },
    });
  }

  function summarize(session: Session): ChatSessionSummary {
    return {
      ticketId: session.ticket.id,
      agentId: session.agentId,
      harness: session.harness.id,
      acpSessionId: session.acpSessionId,
      adapterVersion: session.adapterVersion,
      state: session.state,
      model: session.model,
      mode: session.mode,
      effort: session.effort,
      lastTurnAt: session.lastTurnAt,
      cumulative: session.cumulative.models[modelKey(session)] ?? null,
      queued: session.queue.map((q) => ({ text: q.text, trigger: q.trigger })),
      lastDeliveredSeq: session.lastDeliveredSeq,
      error: session.error,
      cwd: session.cwd,
      cwdTier: session.cwdTier,
      commands: session.commands,
      commandsSource: session.commandsSource,
      staleDefinition: session.definitionStale || undefined,
    };
  }

  function sessionCommandsFromRow(
    harness: HarnessSpec,
    row: { commands_json?: string | null } | null,
  ): { commands: ChatCommand[]; commandsSource: ChatCommandsSource | null } {
    if (row?.commands_json) {
      try {
        return {
          commands: JSON.parse(row.commands_json) as ChatCommand[],
          commandsSource: 'session',
        };
      } catch {
        // fall through to harness cache
      }
    }
    const cached = latestHarnessCommands(harness.id);
    if (cached) return { commands: cached, commandsSource: 'harness-cache' };
    return { commands: [], commandsSource: null };
  }

  function persistSession(session: Session): void {
    upsertChatSession({
      sessionKey: session.key,
      ticketId: session.ticket.id,
      projectSlug: session.ticket.projectSlug,
      ticketSlug: session.ticket.ticketSlug,
      agentId: session.agentId,
      harness: session.harness.id,
      acpSessionId: session.acpSessionId,
      adapterVersion: session.adapterVersion,
      cwd: session.cwd,
      pid: session.client?.pid ?? null,
      profileJson: serializeProfile(session.profile),
      usageSnapshotJson: JSON.stringify(session.cumulative),
      state: session.state,
      lastTurnAt: session.lastTurnAt,
      lastDeliveredSeq: session.lastDeliveredSeq,
      commandsJson: session.commands.length > 0 ? JSON.stringify(session.commands) : null,
      standingFingerprint: session.standingFingerprint,
    });
  }

  async function markStandingDelivered(
    session: Session,
    fingerprint: string,
    gen: number,
  ): Promise<void> {
    if (gen !== session.standingGen) return;
    session.standingSent = true;
    session.standingFingerprint = fingerprint;
    persistSession(session);
  }

  // --- session lookup ------------------------------------------------------

  async function ensureSession(
    ticket: ResolvedTicket,
    agentId?: string | null,
    sessionOptions: { autoDrive?: boolean } = {},
  ): Promise<Session> {
    const builtAtRev = definitionsRev;
    const { definitions, errors } = await loadDefs();
    const definition = resolveAgent(definitions, agentId ?? null);
    if (!definition) {
      throw new ChatSendError(
        agentId
          ? `No agent definition ${JSON.stringify(agentId)}${errors.length ? ` (${errors.join('; ')})` : ''}`
          : 'No agent definitions are available',
        404,
      );
    }

    const key = chatSessionKey(ticket.id, definition.id);
    const existing = sessions.get(key);
    if (existing) {
      existing.ticket = ticket;
      return existing;
    }
    // A construction already under way owns the repair; join it rather than
    // building (and repairing) a second session for the same key.
    const pending = constructing.get(key);
    if (pending) return pending;

    const { participants: participantsAtBuild } = await readParticipantsDetailed(
      ticket.ticketDir,
      definitions,
    );
    const attachedAtBuild = participantsAtBuild.agents.includes(definition.id);

    const build = buildSession(
      ticket,
      definition,
      key,
      builtAtRev,
      attachedAtBuild,
      sessionOptions,
    ).finally(() => {
      constructing.delete(key);
    });
    constructing.set(key, build);
    return build;
  }

  async function buildSession(
    ticket: ResolvedTicket,
    definition: AgentDefinition,
    key: string,
    builtAtRev: number,
    attachedAtBuild: boolean,
    sessionOptions: { autoDrive?: boolean } = {},
  ): Promise<Session> {
    if (pendingAgentDeletes.has(definition.id)) {
      throw new ChatSendError(`No agent definition ${JSON.stringify(definition.id)}`, 404);
    }
    const initialHarnessId = definition.harness;
    const harness = HARNESSES[initialHarnessId as Harness];
    const log = await sharedLog(ticket.ticketDir);
    let row = getChatSession(ticket.id, definition.id);
    let harnessRotated = false;
    if (row && row.harness !== harness.id) {
      deleteChatSession(key);
      harnessRotated = true;
      row = null;
    }
    const profile = resolveSessionProfile(definition, harness);
    const expectedProfileJson = serializeProfile(profile);
    const definitionStaleFromRow = Boolean(row && row.profile_json !== expectedProfileJson);
    const { definitions: defsForStanding } = await loadDefs();
    const { participants: participantsForStanding } = await readParticipantsDetailed(
      ticket.ticketDir,
      defsForStanding,
    );
    const standingMeta = await readTicketStandingMeta(ticket.ticketDir);
    const currentStandingFingerprint = standingFingerprint(
      definition,
      defsForStanding,
      participantsForStanding,
      standingMeta,
    );
    let standingGen = 0;
    let standingSent = Boolean(row?.acp_session_id);
    if (row?.acp_session_id && row.standing_fingerprint !== currentStandingFingerprint) {
      standingSent = false;
      standingGen = 1;
    }
    const commandState = sessionCommandsFromRow(harness, row);
    const session: Session = {
      key,
      ticket,
      agentId: definition.id,
      definition,
      harness,
      profile,
      log,
      normalizer: new ChatNormalizer({
        ticketId: ticket.id,
        agentId: definition.id,
        sessionKey: key,
      }),
      client: null,
      capabilities: null,
      acpSessionId: row?.acp_session_id ?? null,
      adapterVersion: row?.adapter_version ?? null,
      cwd: row?.cwd ?? null,
      cwdTier: null,
      branch: null,
      model: null,
      mode: null,
      effort: null,
      state: row ? 'idle' : 'none',
      standingSent,
      standingGen,
      standingFingerprint: row?.standing_fingerprint ?? null,
      queue: [],
      lastDeliveredSeq: row?.last_delivered_seq ?? 0,
      hopBudget: options.routing?.hopBudget ?? DEFAULT_HOP_BUDGET,
      inFlight: null,
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      permissionSeq: 0,
      questionSeq: 0,
      loading: false,
      unpricedNoticeSent: false,
      cumulative: parseSnapshot(row?.usage_snapshot_json) ?? {
        models: {},
        collectorRunAt: null,
        capturedAt: new Date(now()).toISOString(),
      },
      lastTurnAt: row?.last_turn_at ?? null,
      idleTimer: null,
      flushTimer: null,
      pendingPatches: new Map(),
      error: null,
      commands: commandState.commands,
      commandsSource: commandState.commandsSource,
      driving: Promise.resolve(),
      definitionStale: definitionStaleFromRow,
      stalePromptChanged: false,
      builtAtRev,
      autoApprove: false,
    };

    // The normalizer must pick up where the persisted log left off, so a restart
    // does not restart the per-scope ordinals and collide item ids. Every agent
    // on the ticket shares one log, so replay ONLY this session's events —
    // ingesting another agent's would consume this normalizer's ordinals and
    // re-attribute its items.
    const all = await log.readAll();
    const events = all.filter((event) => event.sessionKey === key);
    for (const event of events) session.normalizer.ingest(event);

    if (!row?.commands_json) {
      const fromLog = latestAdvertisedCommands(events, harness.id);
      if (fromLog) {
        session.commands = fromLog;
        session.commandsSource = 'session';
        setHarnessCommands(harness.id, fromLog);
        persistSession(session);
      }
    }

    // Repair anything the previous process left mid-flight BEFORE the session is
    // reachable, so nothing can drive a half-repaired session (Decision 12).
    // Repair reads the whole log, not just this key: since Decision 3 a message
    // routed to this agent and a handoff aimed at it live in the TICKET
    // scope, and neither is visible under its own key.
    await repairSession(session, events, all);

    if (stopping) {
      // `stopAll` began while this session was being built. Publishing now would
      // put it into a map the shutdown pass has already walked, leaving a
      // session nothing ever tears down (round 3). Shut it down here instead.
      await shutdownSession(session);
      return session;
    }

    if (definitionsRev !== builtAtRev) {
      const { definitions } = await loadDefs();
      const fresh = definitions.find((d) => d.id === definition.id);
      if (!fresh) {
        await shutdownSession(session);
        throw new ChatSendError(`No agent definition ${JSON.stringify(definition.id)}`, 404);
      }
      if (fresh.harness !== initialHarnessId) {
        deleteChatSession(key);
        session.acpSessionId = null;
        session.adapterVersion = null;
        session.standingFingerprint = null;
        invalidateStanding(session);
        session.definition = fresh;
        session.harness = HARNESSES[fresh.harness as Harness];
        session.profile = resolveSessionProfile(fresh, session.harness);
        harnessRotated = true;
      } else {
        const prevPrompt = session.definition.systemPrompt;
        session.definition = fresh;
        session.profile = resolveSessionProfile(fresh, session.harness);
        const freshProfileJson = serializeProfile(session.profile);
        if (
          freshProfileJson !== expectedProfileJson ||
          (row && row.profile_json !== freshProfileJson)
        ) {
          session.definitionStale = true;
          session.stalePromptChanged = prevPrompt !== fresh.systemPrompt;
        }
      }
    }

    if (harnessRotated) {
      await record(
        session,
        'system',
        {
          level: 'info',
          text: `@${session.definition.id}'s harness changed to ${session.harness.id} — starting a new session`,
        },
        null,
      );
    }

    if (pendingAgentDeletes.has(definition.id)) {
      await shutdownSession(session);
      throw new ChatSendError(`No agent definition ${JSON.stringify(definition.id)}`, 404);
    }

    const { definitions: defsForPublish } = await loadDefs();
    const { participants: participantsForPublish } = await readParticipantsDetailed(
      ticket.ticketDir,
      defsForPublish,
    );
    if (!participantsForPublish.agents.includes(definition.id)) {
      if (attachedAtBuild) {
        await shutdownSession(session);
        throw new ChatSendError(`@${definition.id} is not attached to this chat`, 409);
      }
      // Detached before this build began: repair already dropped pending work;
      // publish an idle shell so getSession can report state without driving.
      sessions.set(key, session);
      return session;
    }
    if (row?.acp_session_id) {
      const publishStandingMeta = await readTicketStandingMeta(ticket.ticketDir);
      const publishStandingFingerprint = standingFingerprint(
        session.definition,
        defsForPublish,
        participantsForPublish,
        publishStandingMeta,
      );
      if ((row.standing_fingerprint ?? null) !== publishStandingFingerprint) {
        invalidateStanding(session);
      }
    }

    sessions.set(key, session);

    // Messages recovered by the repair are sent without waiting for the human to
    // type something new — the docs promise they are "re-queued and sent in
    // order", and opening the Chat tab only calls `getSession` (round 2,
    // finding 2).
    if (
      session.queue.length > 0 &&
      !session.inFlight &&
      !stopping &&
      (sessionOptions.autoDrive ?? true)
    ) {
      void drive(session);
    }
    return session;
  }

  /**
   * Release everything a session holds and mark it stopped. Used both by
   * `stopAll` for published sessions and by `buildSession` for one that
   * finished building after shutdown started.
   */
  async function shutdownSession(session: Session): Promise<void> {
    if (session.flushTimer) clearTimeout(session.flushTimer);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.autoApprove = false;
    if (session.client) {
      const client = session.client;
      session.client = null;
      await client.close().catch(() => {});
    }
    session.state = 'stopped';
    persistSession(session);
    if (session.acpSessionId) {
      await updateSessionStatus('', session.acpSessionId, 'stopped', iso()).catch(() => false);
    }
  }

  /**
   * Detaching an agent stops it (Decision 7). The in-flight turn is cancelled,
   * every queued entry is withdrawn with a `system` row naming it, and the
   * adapter is torn down once the cancelled prompt resolves.
   *
   * Letting the turn "finish and idle out" was the other option, and the code
   * review killed it: a detached agent has no chip and no cancel button, so a
   * turn that keeps running is unbounded spend nobody can see or stop.
   *
   * A withdrawn entry does NOT mark its `user.message` withdrawn: the same
   * message may still be queued for, or running on, an agent that is still
   * attached. The row says what was dropped and for whom.
   */
  async function detachSession(session: Session): Promise<void> {
    const dropped = session.queue.splice(0, session.queue.length);
    for (const entry of dropped) {
      await recordTicket(
        session.ticket,
        'route.notice',
        {
          level: 'warn',
          text:
            `@${session.agentId} was detached from this chat, so a queued message for it was ` +
            `withdrawn: ${firstLineOf(entry.text)}`,
        },
        { agentId: SYSTEM_AGENT_ID },
      );
    }

    if (session.inFlight) {
      await cancelTurn(session).catch(() => false);
      // Give the cancelled prompt a moment to resolve so its own `turn.end`
      // wins; the shutdown below seals nothing itself.
      await Promise.race([
        waitFor(() => session.inFlight === null, timeouts.shutdownGraceMs),
        sleep(timeouts.shutdownGraceMs),
      ]);
      await recordTicket(
        session.ticket,
        'route.notice',
        {
          level: 'warn',
          text: `@${session.agentId} was detached from this chat, so its turn was cancelled.`,
        },
        { agentId: SYSTEM_AGENT_ID },
      );
    }

    await shutdownSession(session);
    emitSession(session);
  }

  /**
   * Startup repair (Decision 12). A `SIGKILL` of the dashboard runs no
   * `finishTurn`, so it leaves three kinds of wreckage. The event log is the
   * source of truth for all of it; the index and the engagement table are
   * brought back into line with it. `events` is already narrowed to this
   * session — repairing another agent's turns from a shared log would seal
   * turns that are still running.
   *
   *  1. **Orphaned turns** — a `turn.start` with no `turn.end`/`turn.cancel`.
   *     Left alone the UI shows a `turn.status` stuck in `running` forever and a
   *     new turn stacks beside it. A synthetic `turn.end` with
   *     `stopReason: 'error'` is appended, which seals the item through the
   *     normal path.
   *  2. **A dangling engagement** — `ended_at IS NULL` for this ACP session.
   *     `registerAgentSession` would otherwise close it as `chat-registered`,
   *     filing the crashed turn's spend under a registration window; and on any
   *     path that skips registration, `openEngagement` throws on the
   *     `one_active_per_session` index. It is closed here with reason `error`
   *     and the persisted cumulative snapshot.
   *  3. **Unsent queued messages and unanswered permissions.** Queued messages
   *     are re-enqueued in order so they send on the next drive. A pending
   *     permission cannot be answered — the ACP request died with the adapter
   *     process that made it — so it is resolved as `cancelled` rather than
   *     left as live buttons that would 409.
   */
  async function repairSession(
    session: Session,
    events: ChatEvent[],
    allEvents: ChatEvent[],
  ): Promise<void> {
    const scopeKey = ticketScopeKey(session.ticket.id);
    const openTurns = new Set<string>();
    /**
     * Every trigger a `turn.start` of THIS session ever carried, keyed the way
     * the recovery pass keys its candidates. The log's `user.message` event is
     * written ONCE, at queue time, and keeps `state: 'queued'` forever — it is
     * the derived item that moves on. So "still queued" cannot be read off the
     * last event's state; it means no turn of this agent's ever picked it up.
     */
    const everSent = new Set<string>();
    const openPermissions = new Map<string, string>(); // requestId -> title
    const openAsks = new Map<string, string>(); // requestId -> prompt
    /**
     * Highest `perm:<n>` suffix this session has ever minted. `permissionSeq`
     * restarts at 0 on load, so without this a new request would reuse an id
     * the log already holds and collide with a still-rendered item (round 2,
     * finding 3).
     */
    let maxPermissionSeq = -1;
    let maxQuestionSeq = -1;

    for (const event of events) {
      switch (event.kind) {
        case 'turn.start': {
          const trigger = triggerOf(event);
          if (trigger) everSent.add(triggerKey(trigger));
          if (event.turnId) openTurns.add(event.turnId);
          break;
        }
        case 'turn.end':
        case 'turn.cancel':
          if (event.turnId) openTurns.delete(event.turnId);
          break;
        case 'acp.permission_request': {
          const payload = event.payload as PermissionRequestPayload;
          openPermissions.set(
            payload.requestId,
            payload.request?.toolCall?.title ?? payload.requestId,
          );
          const suffix = Number(payload.requestId.split(':perm:')[1]);
          if (Number.isInteger(suffix)) maxPermissionSeq = Math.max(maxPermissionSeq, suffix);
          break;
        }
        case 'acp.permission_response': {
          const payload = event.payload as PermissionResponsePayload;
          openPermissions.delete(payload.requestId);
          break;
        }
        case 'acp.ext': {
          const payload = event.payload as AcpExtPayload;
          if (payload.method === 'cursor/ask_question' && payload.requestId) {
            const params = payload.params as {
              questions?: Array<{ prompt?: string }>;
              title?: string;
            };
            const prompt =
              params.questions?.[0]?.prompt ?? params.title ?? 'A question';
            openAsks.set(payload.requestId, prompt);
            const suffix = Number(payload.requestId.split(':question:')[1]);
            if (Number.isInteger(suffix)) maxQuestionSeq = Math.max(maxQuestionSeq, suffix);
          }
          break;
        }
        case 'question.answered': {
          const payload = event.payload as QuestionAnsweredPayload;
          openAsks.delete(payload.requestId);
          break;
        }
      }
    }

    /**
     * What this agent should still run, in log order. Routing is NEVER re-run
     * and no new `handoff` is written: a chain survives a crash exactly as far
     * as its already-recorded handoffs and nothing beyond them is invented.
     */
    const pending = new Map<string, { text: string; trigger: TurnTrigger; attachments?: ChatAttachment[] }>();
    for (const event of allEvents) {
      if (event.sessionKey === scopeKey) {
        if (event.kind === 'user.message') {
          const payload = event.payload as UserMessagePayload;
          if (payload.state === 'withdrawn') {
            pending.delete(triggerKey({ kind: 'human', messageId: payload.messageId }));
          } else if ((payload.targets ?? []).includes(session.agentId)) {
            pending.set(triggerKey({ kind: 'human', messageId: payload.messageId }), {
              text: payload.text,
              trigger: { kind: 'human', messageId: payload.messageId },
              ...(payload.attachments ? { attachments: payload.attachments } : {}),
            });
          }
        } else if (event.kind === 'handoff') {
          const payload = event.payload as HandoffPayload;
          if (payload.toAgentId !== session.agentId) continue;
          const trigger: TurnTrigger = {
            kind: 'handoff',
            handoffId: payload.handoffId,
            fromAgentId: payload.fromAgentId,
            hop: payload.hop,
          };
          pending.set(triggerKey(trigger), { text: payload.text, trigger });
        }
      } else if (event.sessionKey === session.key && event.kind === 'user.message') {
        // A phase-2 line: `user.message` under the handling agent's own key,
        // with no `targets`. The key IS the routing (Decision 3).
        const payload = event.payload as UserMessagePayload;
        const key = triggerKey({ kind: 'human', messageId: payload.messageId });
        if (payload.state === 'withdrawn') pending.delete(key);
        else if (payload.targets === undefined) {
          pending.set(key, {
            text: payload.text,
            trigger: { kind: 'human', messageId: payload.messageId },
            ...(payload.attachments ? { attachments: payload.attachments } : {}),
          });
        }
      }
    }

    // Anything a turn already picked up is not re-queued — including the trigger
    // an in-flight turn was carrying when the process died, which reached the
    // agent and is sealed with that turn rather than sent twice.
    for (const key of everSent) pending.delete(key);

    // An agent detached since the crash must not be resurrected by its own
    // history (code review round 1, finding 3). Decision 7 withdraws the queue
    // at detach time, so this is the guarantee rather than the common path —
    // and it FAILS OPEN: an unreadable participants file must not silently
    // discard recovered work.
    if (pending.size > 0) {
      try {
        const { participants } = await routingContext(session.ticket);
        if (!participants.agents.includes(session.agentId)) pending.clear();
      } catch {
        // Definitions or participants unreadable — recover everything.
      }
    }

    // Continue the id sequence rather than restarting it, whether or not there
    // is anything else to repair.
    session.permissionSeq = maxPermissionSeq + 1;
    session.questionSeq = maxQuestionSeq + 1;

    if (openTurns.size === 0 && pending.size === 0 && openPermissions.size === 0 && openAsks.size === 0) {
      // Still close a dangling engagement even with a clean log — an engagement
      // can outlive its turn if the process died between the two writes.
      closeDanglingEngagement(session);
      return;
    }

    const cardItemIds: Array<{ kind: ChatQuestionKind; ids: string[] }> = [];
    for (const [requestId] of openPermissions) {
      const item = findChatItemByRequestId(session.ticket.id, requestId);
      cardItemIds.push({ kind: 'permission', ids: [item?.itemId ?? requestId, requestId] });
    }
    for (const [requestId] of openAsks) {
      const item = findChatItemByRequestId(session.ticket.id, requestId);
      cardItemIds.push({ kind: 'ask', ids: [item?.itemId ?? requestId, requestId] });
    }
    if (cardItemIds.length > 0) {
      try {
        await withRecordLock(session.ticket.ticketDir, () =>
          resolveQuestionComments(session.ticket.ticketDir, (c) =>
            cardItemIds.some((entry) => byKindAndItemIds(entry.kind, entry.ids)(c)),
          ),
        );
      } catch {
        /* best-effort */
      }
    }

    for (const [requestId, title] of openPermissions) {
      await record(session, 'acp.permission_response', { requestId, cancelled: true }, null);
      await record(
        session,
        'system',
        { level: 'warn', text: `The request to run ${title} expired when the dashboard restarted` },
        null,
      );
    }

    for (const [requestId, prompt] of openAsks) {
      await record(session, 'question.answered', { requestId, by: 'timeout' }, null);
      await record(
        session,
        'system',
        { level: 'warn', text: `The question "${prompt}" expired when the dashboard restarted` },
        null,
      );
    }

    for (const turnId of openTurns) {
      await record(
        session,
        'turn.end',
        {
          stopReason: 'error',
          endedAt: iso(),
          error: 'the dashboard stopped while this turn was running',
        },
        turnId,
      );
    }

    closeDanglingEngagement(session);

    if (pending.size > 0) {
      // Through `enqueue()` rather than a bare push, so "one queue entry per
      // trigger" is enforced in ONE place for both routing and recovery
      // (code review round 1, finding 6).
      for (const entry of pending.values()) enqueue(session, entry);
      await record(
        session,
        'system',
        {
          level: 'info',
          text: `Resuming ${pending.size} message${pending.size === 1 ? '' : 's'} queued before the dashboard restarted`,
        },
        null,
      );
    }
    flush(session);
  }

  /** Close an engagement the previous process left open for this ACP session. */
  function closeDanglingEngagement(session: Session): void {
    if (!session.acpSessionId) return;
    const open = getOpenEngagement(session.acpSessionId);
    if (!open) return;
    closeEngagementById({
      id: open.id,
      startedAt: open.started_at,
      closeReason: 'error',
      // The persisted snapshot is the last thing the crashed process knew; using
      // it keeps the window computable and prices the crashed turn at whatever
      // it had actually spent.
      tokensAtClose: snapshotOf(session),
      endedAt: iso(),
    });
  }

  /**
   * Materialise every session this ticket has on disk, so `withdraw`,
   * `cancel` and `answerPermission` see the rehydrated queue and permission
   * state after a restart instead of an empty in-memory map (finding 8).
   */
  async function ensureTicketSessions(
    ticket: ResolvedTicket,
    sessionOptions: { autoDrive?: boolean } = {},
  ): Promise<Session[]> {
    const agentIds = new Set(listChatSessions(ticket.id).map((row) => row.agent_id));
    // Attached agents count even before they have a row: `withdraw`, `cancel`
    // and the SPA's initial load must all see the same set (round 1, finding
    // 12), and an agent attached in the picker has no row until it first runs.
    try {
      const { participants } = await routingContext(ticket);
      for (const agentId of participants.agents) agentIds.add(agentId);
    } catch {
      // Unreadable definitions must not hide the sessions that DO have rows.
    }
    for (const agentId of agentIds) {
      const key = chatSessionKey(ticket.id, agentId);
      if (constructing.has(key)) continue;
      try {
        await ensureSession(ticket, agentId, sessionOptions);
      } catch {
        // A definition that has since been deleted or broken must not stop the
        // others from being reachable.
      }
    }
    if (agentIds.size === 0) await ensureSession(ticket, null).catch(() => undefined);
    return [...sessions.values()].filter((s) => s.ticket.id === ticket.id);
  }

  /**
   * Read `workspace.*` from ticket.md and resolve the adapter's cwd.
   * Uses the chat-specific resolver that adds project-repository and home
   * fallback tiers — a chat is never refused for a missing worktree.
   */
  async function resolveCwd(session: Session): Promise<string> {
    const path = resolve(session.ticket.ticketDir, 'ticket.md');
    let frontmatter = '';
    try {
      [frontmatter] = extractFrontmatter(await readFile(path, 'utf-8'));
    } catch {
      throw new ChatSendError(`Cannot read ${path}`, 500);
    }
    const worktreePath = getNestedField(frontmatter, 'workspace', 'worktreePath');
    const repository = getNestedField(frontmatter, 'workspace', 'repository');
    const branch = getNestedField(frontmatter, 'workspace', 'branch');

    // Read project.md repositories for the project-tier fallback.
    let projectRepositories: string[] = [];
    if (session.ticket.projectSlug) {
      try {
        const projectPath = resolve(
          options.projectsDir,
          session.ticket.projectSlug,
          'project.md',
        );
        const [projectFm] = extractFrontmatter(await readFile(projectPath, 'utf-8'));
        projectRepositories = parseRepositories(projectFm);
      } catch {
        // Missing or unreadable project.md — skip the project tier.
      }
    }

    const result = resolveChatCwd({
      worktreePath,
      repository,
      branch,
      ticketSlug: session.ticket.ticketSlug,
      projectRepositories,
    });
    session.branch = branch;
    session.cwdTier = result.tier;
    return result.cwd;
  }

  /**
   * Parse `repositories:` from project.md frontmatter. Handles both YAML
   * block-style (`repositories:\n  - /path`) and inline empty (`repositories: []`).
   */
  function parseRepositories(frontmatter: string): string[] {
    const inlineEmpty = frontmatter.match(/^repositories:\s*\[\s*\]/m);
    if (inlineEmpty) return [];
    const block = frontmatter.match(/^repositories:\s*\n((?:\s+-\s+.*\n?)*)/m);
    if (!block) return [];
    return block[1]
      .split('\n')
      .map((line) => line.replace(/^\s+-\s+/, '').trim())
      .filter((line) => line.length > 0)
      .map((line) => line.replace(/^["']|["']$/g, ''));
  }

  // --- adapter lifecycle ---------------------------------------------------

  function spawn(session: Session, cwd: string): AcpClient {
    const resolved = commandResolver(session.harness);
    if (!resolved.path) {
      throw new ChatSendError(
        `${session.harness.command} is not on PATH — install it with: ${resolved.installHint}`,
        503,
      );
    }
    return clientFactory({
      agentId: session.agentId,
      harness: session.harness,
      command: resolved.path,
      args: [...session.harness.args],
      cwd,
      env: {
        ...profileEnv(profileForTier(session.profile, session.cwdTier)),
        // Prevent the SessionStart hook from merging into ~/.syntaur/context.json
        // when the session is running from the home directory.
        ...(session.cwdTier === 'home' ? { SYNTAUR_SKIP_CONTEXT_MERGE: '1' } : {}),
      },
      onUpdate: (notification) => {
        void onUpdate(session, notification);
      },
      onPermissionRequest: (request) => onPermissionRequest(session, request),
      onExtRequest: (method, params) => onExtRequest(session, method, params),
      onExtNotification: (method, params) => onExtNotification(session, method, params),
      onExit: (info) => {
        void onExit(session, info);
      },
    });
  }

  async function swapHarnessInPlace(session: Session, fresh: AgentDefinition): Promise<void> {
    if (session.inFlight) {
      await cancelTurn(session).catch(() => false);
      await Promise.race([
        waitFor(() => session.inFlight === null, timeouts.shutdownGraceMs),
        sleep(timeouts.shutdownGraceMs),
      ]);
    }
    await shutdownSession(session);
    deleteChatSession(session.key);
    session.acpSessionId = null;
    invalidateStanding(session);
    session.standingFingerprint = null;
    session.definition = fresh;
    session.harness = HARNESSES[fresh.harness as Harness];
    session.profile = resolveSessionProfile(fresh, session.harness);
    session.definitionStale = false;
    session.stalePromptChanged = false;
    session.autoApprove = false;
  }

  async function ensureAdapter(session: Session): Promise<void> {
    const { definitions } = await loadDefs();
    const fresh = definitions.find((d) => d.id === session.agentId);
    if (!fresh) {
      throw new ChatSendError(`No agent definition ${JSON.stringify(session.agentId)}`, 404);
    }
    if (definitionChanged(session.definition, fresh)) {
      if (session.harness.id !== fresh.harness) {
        await swapHarnessInPlace(session, fresh);
      } else {
        session.definition = fresh;
        session.profile = resolveSessionProfile(fresh, session.harness);
        session.definitionStale = true;
      }
    }

    if (session.client?.alive() && session.acpSessionId) {
      if (session.definitionStale && !session.inFlight) {
        await applyPins(session, session.client, session.acpSessionId);
      }
      return;
    }

    const previousCwd = session.cwd;
    const cwd = await resolveCwd(session);
    session.cwd = cwd;

    // The home tier runs read-only unless the definition pins a mode; see
    // `profileForTier`. It is applied where the profile is USED, never stored,
    // so a later move to a worktree restores the definition's own mode.

    // Emit a system row when the cwd/tier changes (e.g. worktree created later).
    if (previousCwd && previousCwd !== cwd) {
      await record(session, 'system', {
        level: 'info',
        text: `Working directory changed to ${cwd} (${session.cwdTier})`,
      }, null);
      // Tear down the existing session so it starts fresh at the new cwd.
      if (session.client) {
        await shutdownSession(session);
      }
    }

    setState(session, 'spawning');

    const client = spawn(session, cwd);
    session.client = client;

    let init: acp.InitializeResponse;
    try {
      init = await client.initialize();
    } catch (err) {
      // Only now is the auth probe worth its latency — it EXPLAINS a failure,
      // it is never a gate.
      const probe = authProber(session.harness);
      setHarnessAuth(session.harness.id, 'failed', probe);
      await client.close();
      session.client = null;
      setState(session, 'error', `${(err as Error).message} — ${probe}`);
      throw new ChatSendError(
        `${session.harness.command} failed to start: ${(err as Error).message}. ${probe}`,
        503,
      );
    }
    session.adapterVersion = readAdapterVersion(init);
    session.capabilities = init.agentCapabilities ?? null;

    const previous = session.acpSessionId;
    let attached = false;
    if (previous) {
      if (session.harness.reattach === 'resume') {
        try {
          const resumeResponse = await client.resumeSession(previous, cwd);
          if (resumeResponse) readSessionConfig(session, resumeResponse);
          await record(session, 'session.resumed', {
            acpSessionId: previous,
            harness: session.harness.id,
            adapterVersion: session.adapterVersion,
            cwd,
            via: 'resume',
          }, null);
          attached = true;
        } catch (err) {
          await record(session, 'session.rotated', {
            acpSessionId: previous,
            text: `Could not resume the previous agent session (${(err as Error).message}) — started a new one`,
            harness: session.harness.id,
          } satisfies SessionRotatedPayload, null);
          invalidateStanding(session);
          session.acpSessionId = null;
        }
      } else if (session.capabilities?.loadSession) {
        await record(session, 'session.load', { acpSessionId: previous }, null);
        session.loading = true;
        let loadResponse: acp.LoadSessionResponse | null = null;
        let loadError: Error | null = null;
        try {
          loadResponse = await client.loadSession(previous, cwd);
        } catch (err) {
          loadError = err instanceof Error ? err : new Error(String(err));
        } finally {
          session.loading = false;
          await record(session, 'session.loaded', {}, null);
        }
        if (loadResponse && !loadError) {
          readSessionConfig(session, loadResponse);
          await record(session, 'session.resumed', {
            acpSessionId: previous,
            harness: session.harness.id,
            adapterVersion: session.adapterVersion,
            cwd,
            via: 'load',
          }, null);
          attached = true;
        } else {
          await record(session, 'session.rotated', {
            acpSessionId: previous,
            text: `Could not load the previous agent session (${loadError?.message ?? 'unknown error'}) — started a new one`,
            harness: session.harness.id,
          } satisfies SessionRotatedPayload, null);
          invalidateStanding(session);
          session.acpSessionId = null;
        }
      } else {
        await record(session, 'session.rotated', {
          acpSessionId: previous,
          text: 'Previous agent session could not be reattached — started a new one',
          harness: session.harness.id,
        } satisfies SessionRotatedPayload, null);
        invalidateStanding(session);
        session.acpSessionId = null;
      }
    }

    if (attached && session.definitionStale && session.acpSessionId) {
      await applyPins(session, client, session.acpSessionId);
    }

    if (!attached) {
      const profile = profileForTier(session.profile, session.cwdTier);
      const meta = newSessionMeta(profile, session.harness, session.definition.systemPrompt);
      const created = await client.newSession({ cwd, mcpServers: meta.mcpServers, _meta: meta._meta });
      session.acpSessionId = created.sessionId;
      readSessionConfig(session, created);
      const { applied, errors } = await applyProfile(
        client,
        created.sessionId,
        profile,
        session.harness,
      );
      if (applied.mode) session.mode = applied.mode;
      if (applied.model) session.model = applied.model;
      if (applied.effort) session.effort = applied.effort;
      await record(session, 'session.created', {
        acpSessionId: created.sessionId,
        harness: session.harness.id,
        adapterVersion: session.adapterVersion,
        cwd,
        applied,
      }, null);
      for (const error of errors) {
        await record(session, 'system', { level: 'warn', text: `Could not pin ${error}` }, null);
      }
      invalidateStanding(session);
      session.definitionStale = false;
      session.stalePromptChanged = false;
    }

    await registerAgentSession(session, cwd);
    setState(session, 'ready', null);

    // Announce where the session is running.
    if (session.cwdTier && session.cwdTier !== 'worktree') {
      const tierMessages: Record<string, string> = {
        repository: `Running in ${cwd} (repository fallback)`,
        project: `Running in ${cwd} (project repository) — this ticket has no worktree; create one from the ticket header`,
        home: `Running in ${cwd} — this ticket has no worktree; create one from the ticket header`,
      };
      const text = tierMessages[session.cwdTier];
      if (text) await record(session, 'system', { level: 'info', text }, null);
    }
  }

  /**
   * Register the chat session as a `sessions` row keyed by the ACP session id
   * (Decision 1). That id IS the underlying Claude Code transcript id / codex
   * rollout id, so the scanner's later discovery upserts this row instead of
   * creating a duplicate, and usage joins land on it.
   *
   * `appendSession` auto-opens an engagement for an active row; it is closed
   * immediately so the per-turn engagements own every interval.
   */
  async function registerAgentSession(session: Session, cwd: string): Promise<void> {
    if (!session.acpSessionId) return;
    await appendSession(
      '',
      {
        sessionId: session.acpSessionId,
        projectSlug: session.ticket.projectSlug,
        ticketSlug: session.ticket.ticketSlug,
        ticketId: session.ticket.id,
        agent: session.harness.id,
        started: iso(),
        status: 'active',
        path: cwd,
        description: null,
        transcriptPath: null,
        originalHeadSha: null,
        hostedBy: 'acp',
      },
      // The row may be `stopped` from an idle teardown or a dashboard restart;
      // the broker owns its lifecycle, so it revives it itself.
      { reviveStopped: true },
    );
    // `appendSession` auto-opens an engagement for an active row; close it at
    // once so the per-turn engagements own every interval. It carries the same
    // snapshot at both ends so the window is computable-and-zero rather than
    // counting against `uncomputableWindowCount` on the usage rail.
    const snapshot = snapshotOf(session);
    closeOpenEngagement(session.acpSessionId, {
      closeReason: 'chat-registered',
      tokensAtClose: snapshot,
      endedAt: iso(),
    });
  }

  /** Both `session/new` and `session/resume` return `modes` + `configOptions`. */
  function noteHarnessOptions(
    harness: Harness,
    adapterVersion: string | null,
    response: Pick<acp.NewSessionResponse, 'modes' | 'configOptions'>,
  ): void {
    const configOptions = response.configOptions;
    if (!Array.isArray(configOptions) || configOptions.length === 0) return;
    const { options, modes } = parseHarnessOptions(response);
    upsertHarnessOptions({
      harness,
      adapterVersion,
      capturedAt: iso(),
      options,
      modes,
    });
  }

  function readSessionConfig(
    session: Session,
    response: Pick<acp.NewSessionResponse, 'modes' | 'configOptions'>,
  ): void {
    session.mode = response.modes?.currentModeId ?? session.mode;
    const effortId = session.harness.configIds.effort;
    for (const option of response.configOptions ?? []) {
      const value = (option as { id?: string; currentValue?: unknown }).currentValue;
      const id = (option as { id?: string }).id;
      if (typeof value !== 'string') continue;
      if (id === session.harness.configIds.model) session.model = value;
      else if (effortId && id === effortId) session.effort = value;
      else if (id === 'mode' || id === 'collaboration_mode') session.mode = value;
    }
    noteHarnessOptions(session.harness.id, session.adapterVersion, response);
  }

  function harnessSummaries(): ChatHarnessSummary[] {
    return HARNESS_IDS.map((id) => {
      const spec = HARNESSES[id];
      const resolved = commandResolver(spec);
      const { record, auth } = getHarnessOptions(id);
      return {
        id,
        label: spec.label,
        command: spec.command,
        args: [...spec.args],
        installed: resolved.path,
        installHint: spec.installHint,
        modelConfigId: spec.configIds.model,
        effortConfigId: spec.configIds.effort ?? null,
        roleModes: spec.modeIds,
        systemPromptTransport: spec.systemPromptTransport,
        options: record,
        auth,
      };
    });
  }

  async function openThrowaway(input: {
    harness: HarnessSpec;
    definition: AgentDefinition | null;
    prompt: string | null;
    timeoutMs: number;
  }): Promise<AgentTestResult | void> {
    const started = now();
    const resolved = commandResolver(input.harness);
    if (!resolved.path) {
      throw new ChatSendError(
        `${input.harness.command} is not on PATH — install it with: ${resolved.installHint}`,
        503,
      );
    }

    const probeDir = await mkdtemp(join(tmpdir(), 'syntaur-chat-probe-'));

    const profile = input.definition
      ? resolveSessionProfile(input.definition, input.harness)
      : inheritedProfile();
    const systemPrompt = input.definition?.systemPrompt ?? '';

    let reply = '';
    let model: string | null = null;
    let mode: string | null = null;
    let effort: string | null = null;
    let profileErrors: string[] = [];
    let client: AcpClient | null = null;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let commands: ChatCommand[] | null = null;

    try {
      client = clientFactory({
        agentId: input.definition?.id ?? `probe:${input.harness.id}`,
        harness: input.harness,
        command: resolved.path,
        args: [...input.harness.args],
        cwd: probeDir,
        env: { ...profileEnv(profile), SYNTAUR_SKIP_CONTEXT_MERGE: '1' },
        onUpdate: (notification) => {
          const raw = notification as acp.SessionNotification | acp.SessionUpdate;
          const update = 'update' in raw && raw.update ? raw.update : (raw as acp.SessionUpdate);
          if (update.sessionUpdate === 'agent_message_chunk') {
            reply += blockText(update.content as ContentBlock);
          }
          if (update.sessionUpdate === 'available_commands_update') {
            const parsed = parseAvailableCommands(update);
            if (parsed.length > 0) commands = parsed;
          }
        },
        onPermissionRequest: async (request) => ({
          outcome: { outcome: 'selected', optionId: rejectOption(request.options ?? []) },
        }),
        onExtRequest: async (method) => {
          if (method === 'cursor/create_plan') return { outcome: { outcome: 'accepted' } };
          if (method === 'cursor/ask_question') return { outcome: { outcome: 'cancelled' } };
          return {};
        },
        onExit: () => {},
      });

      let init: acp.InitializeResponse;
      try {
        init = await client.initialize();
      } catch (err) {
        const probe = authProber(input.harness);
        setHarnessAuth(input.harness.id, 'failed', probe);
        await client.close();
        throw new ChatSendError(
          `${input.harness.command} failed to start: ${(err as Error).message}. ${probe}`,
          503,
        );
      }

      const adapterVersion = readAdapterVersion(init);
      const meta = newSessionMeta(profile, input.harness, systemPrompt);
      const newResp = await client.newSession({
        cwd: probeDir,
        mcpServers: meta.mcpServers,
        _meta: meta._meta,
      });
      const sessionId = newResp.sessionId;
      noteHarnessOptions(input.harness.id, adapterVersion, newResp);

      const effortId = input.harness.configIds.effort;
      for (const option of newResp.configOptions ?? []) {
        const value = (option as { id?: string; currentValue?: unknown }).currentValue;
        const id = (option as { id?: string }).id;
        if (typeof value !== 'string') continue;
        if (id === input.harness.configIds.model) model = value;
        else if (effortId && id === effortId) effort = value;
        else if (id === 'mode' || id === 'collaboration_mode') mode = value;
      }
      mode = newResp.modes?.currentModeId ?? mode;

      if (input.definition) {
        const applied = await applyProfile(client, sessionId, profile, input.harness);
        profileErrors = applied.errors;
        model = applied.applied.model ?? model;
        mode = applied.applied.mode ?? mode;
        effort = applied.applied.effort ?? effort;
      }

      if (!input.prompt) {
        await waitFor(() => commands !== null, timeouts.throwawayCommandsMs);
        return;
      }

      const blocks: ContentBlock[] = [];
      if (input.harness.systemPromptTransport === 'prompt' && systemPrompt.trim()) {
        blocks.push(textBlock(`<system>\n${systemPrompt.trim()}\n</system>`));
      }
      blocks.push(textBlock(input.prompt));

      let stopReason: string | null = null;
      try {
        const response = await Promise.race([
          client.prompt(sessionId, blocks),
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new Error(`timed out after ${input.timeoutMs}ms`)),
              input.timeoutMs,
            );
            timeoutHandle.unref?.();
          }),
        ]);
        stopReason = response.stopReason ?? null;
      } catch (err) {
        await client.cancel(sessionId).catch(() => {});
        return {
          ok: false,
          reply: reply.trim() || null,
          stopReason,
          model,
          mode,
          effort,
          profileErrors,
          durationMs: now() - started,
          error: (err as Error).message,
        };
      }

      const trimmed = reply.trim();
      return {
        ok: stopReason === 'end_turn' && trimmed.length > 0,
        reply: trimmed || null,
        stopReason,
        model,
        mode,
        effort,
        profileErrors,
        durationMs: now() - started,
        error: null,
      };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (commands) setHarnessCommands(input.harness.id, commands);
      if (client) await client.close().catch(() => {});
      await rm(probeDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function refreshHarness(id: Harness): Promise<ChatHarnessSummary> {
    const existing = refreshing.get(id);
    if (existing) return existing;
    const run = (async () => {
      const spec = HARNESSES[id];
      if (!spec) throw new ChatSendError(`Unknown harness ${JSON.stringify(id)}`, 404);
      await openThrowaway({ harness: spec, definition: null, prompt: null, timeoutMs: timeouts.throwawayMs });
      const summary = harnessSummaries().find((h) => h.id === id);
      if (!summary) throw new ChatSendError(`Unknown harness ${JSON.stringify(id)}`, 404);
      return summary;
    })();
    refreshing.set(id, run);
    try {
      return await run;
    } finally {
      refreshing.delete(id);
    }
  }

  async function testAgent(id: string): Promise<AgentTestResult> {
    assertWritableAgentId(id);
    const existing = testing.get(id);
    if (existing) return existing;
    const run = (async () => {
      const { definitions } = await loadDefs();
      const def = definitions.find((d) => d.id === id);
      if (!def) throw new ChatSendError(`No agent definition ${JSON.stringify(id)}`, 404);
      const result = await openThrowaway({
        harness: HARNESSES[def.harness],
        definition: def,
        prompt: TEST_PROMPT,
        timeoutMs: timeouts.throwawayMs,
      });
      return result as AgentTestResult;
    })();
    testing.set(id, run);
    try {
      return await run;
    } finally {
      testing.delete(id);
    }
  }

  async function saveAgent(input: AgentDefinitionInput): Promise<AgentDefinition> {
    assertWritableAgentId(input.id);
    const home = options.syntaurHome ?? syntaurRoot();
    const run = agentWrites.then(async () => {
      const { definitions: before } = await loadDefinitions(home);
      const old = before.find((d) => d.id === input.id);
      let definition: AgentDefinition;
      try {
        definition = await writeAgentDefinition(home, input);
      } catch (err) {
        if (err instanceof AgentDefinitionError) {
          throw new AgentWriteError(400, err.reason);
        }
        throw err;
      }
      if (rosterPresentationChanged(old, definition)) {
        await invalidateStandingForParticipant(definition.id);
      }
      definitionsRev += 1;
      await applyDefinitionToSessions(input.id, definition);
      await broadcastAgents();
      return definition;
    });
    agentWrites = run.catch(() => undefined);
    return run;
  }

  async function deleteAgent(id: string): Promise<{ restoredBuiltin: boolean }> {
    assertWritableAgentId(id);
    const home = options.syntaurHome ?? syntaurRoot();
    pendingAgentDeletes.add(id);
    const run = agentWrites.then(async () => {
      try {
      await invalidateStandingForParticipant(id);
      const result = await deleteAgentDefinition(home, id);
      definitionsRev += 1;
      if (result.restoredBuiltin) {
        const { definitions } = await loadDefs();
        const builtin = definitions.find((d) => d.id === id);
        if (!builtin) throw new ChatSendError(`No agent definition ${JSON.stringify(id)}`, 404);
        await applyDefinitionToSessions(id, builtin, { restoredBuiltin: true });
      } else {
        const touched = new Map<string, ResolvedTicket>();
        for (const session of [...sessions.values()]) {
          if (session.agentId !== id) continue;
          touched.set(session.ticket.id, session.ticket);
          await detachSession(session);
          deleteChatSession(session.key);
          sessions.delete(session.key);
        }
        deleteChatSessionsForAgent(id);
        const { definitions } = await loadDefs();
        for (const ticket of touched.values()) {
          const { participants: current } = await readParticipantsDetailed(
            ticket.ticketDir,
            definitions,
          );
          const next = {
            ...current,
            agents: current.agents.filter((agentId) => agentId !== id),
            defaultAgent:
              current.defaultAgent === id
                ? current.agents.find((agentId) => agentId !== id) ?? null
                : current.defaultAgent,
          };
          const participants = await writeParticipants(ticket.ticketDir, next, definitions);
          await recordTicket(ticket,
            'system',
            {
              level: 'info',
              text: `@${id} is no longer in this chat — its agent definition was deleted`,
            },
            { agentId: SYSTEM_AGENT_ID },
          );
          options.broadcast({
            type: 'chat-participants',
            projectSlug: ticket.projectSlug,
            ticketSlug: ticket.ticketSlug,
          timestamp: iso(),
          payload: {
            ticketId: ticket.id,
              participants,
              agents: definitions.map((d) => toAgentSummary(d, commandResolver)),
            },
          });
        }
      }
      await broadcastAgents();
      return result;
      } finally {
        pendingAgentDeletes.delete(id);
      }
    });
    agentWrites = run.catch(() => undefined);
    return run;
  }

  const LOAD_REPLAY_SKIP = new Set([
    'user_message_chunk',
    'agent_message_chunk',
    'agent_thought_chunk',
    'tool_call',
    'tool_call_update',
    'plan',
  ]);

  // --- adapter callbacks ---------------------------------------------------

  async function onUpdate(session: Session, notification: acp.SessionNotification): Promise<void> {
    const turn = session.inFlight;
    const update = notification.update as {
      sessionUpdate?: string;
      cost?: { amount?: number } | null;
      availableCommands?: unknown;
    };
    if (session.loading && update.sessionUpdate && LOAD_REPLAY_SKIP.has(update.sessionUpdate)) {
      return;
    }
    if (turn) {
      // Any activity resets the idle watchdog. claude's silent window at the
      // inherited xhigh effort is 25 s, so this has to be minutes, not seconds.
      armTurnIdle(session, turn);
      if (update.sessionUpdate === 'usage_update' && typeof update.cost?.amount === 'number') {
        const usageSpec = session.harness.usage;
        if (usageSpec.kind === 'adapter-cost' && usageSpec.basis === 'per-turn') {
          turn.reportedCumulativeCost =
            (turn.reportedCumulativeCost ?? turn.costAtOpen) + update.cost.amount;
        } else {
          // Cumulative for the session, not for this turn — see Decision 11.
          turn.reportedCumulativeCost = update.cost.amount;
        }
      }
    }
    if (update.sessionUpdate === 'available_commands_update') {
      const parsed = parseAvailableCommands(update);
      if (!commandsEqual(session.commands, parsed) && parsed.length > 0) {
        session.commands = parsed;
        session.commandsSource = 'session';
        setHarnessCommands(session.harness.id, parsed);
        persistSession(session);
        emitSession(session);
      }
    }
    await record(session, 'acp.update', notification.update);
  }

  async function onPermissionRequest(
    session: Session,
    request: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const requestId = `${session.key}:perm:${session.permissionSeq++}`;
    const title = request.toolCall?.title ?? request.toolCall?.toolCallId ?? 'a tool call';
    const auto = session.autoApprove || session.definition.permissions === 'auto';
    if (auto) {
      const optionId = allowOption(request.options ?? []);
      await record(session, 'acp.permission_request', { requestId, request });
      await record(session, 'acp.permission_response', { requestId, optionId, by: 'auto' });
      return { outcome: { outcome: 'selected', optionId } };
    }
    return new Promise<acp.RequestPermissionResponse>((resolvePermission) => {
      const timer = setTimeout(() => {
        void timeoutPermission(session, requestId, title);
      }, timeouts.permissionMs);
      timer.unref?.();
      const pending: PendingPermission = {
        resolve: resolvePermission,
        timer,
        title,
        options: request.options ?? [],
        graceTimer: null,
        inboxCommentId: null,
        recorded: record(session, 'acp.permission_request', { requestId, request }).catch(() => {}),
      };
      session.pendingPermissions.set(requestId, pending);
      armCardGraceTimer(session, requestId, 'permission', title, pending);
    });
  }

  function onExtRequest(
    session: Session,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    if (method === 'cursor/create_plan') {
      const requestId = `${session.key}:ext:${session.questionSeq++}`;
      void record(session, 'acp.ext', { method, params, requestId });
      return Promise.resolve({ outcome: { outcome: 'accepted' } });
    }
    if (method === 'cursor/ask_question') {
      const requestId = `${session.key}:question:${session.questionSeq++}`;
      const body = params as {
        toolCallId?: string;
        title?: string;
        questions?: Array<{
          id: string;
          prompt: string;
          options?: Array<{ id: string; label: string }>;
          allowMultiple?: boolean;
        }>;
      };
      const prompt = body.questions?.[0]?.prompt ?? body.title ?? 'A question';
      return new Promise<unknown>((resolveQuestion) => {
        const timer = setTimeout(() => {
          void timeoutQuestion(session, requestId);
        }, timeouts.permissionMs);
        timer.unref?.();
        const pending: PendingQuestion = {
          resolve: resolveQuestion,
          timer,
          toolCallId: body.toolCallId ?? requestId,
          questions: body.questions ?? [],
          graceTimer: null,
          inboxCommentId: null,
          recorded: record(session, 'acp.ext', { method, params, requestId }).catch(() => {}),
        };
        session.pendingQuestions.set(requestId, pending);
        armCardGraceTimer(session, requestId, 'ask', prompt, pending);
      });
    }
    const requestId = `${session.key}:ext:${session.questionSeq++}`;
    void record(session, 'acp.ext', { method, params, requestId });
    return Promise.resolve({});
  }

  function onExtNotification(session: Session, method: string, params: unknown): void {
    void record(session, 'acp.ext', { method, params });
  }

  async function timeoutQuestion(session: Session, requestId: string): Promise<void> {
    const pending = session.pendingQuestions.get(requestId);
    if (!pending) return;
    await settlePendingCard(session, pending);
    session.pendingQuestions.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve({ outcome: { outcome: 'cancelled' } });
    await record(session, 'question.answered', { requestId, by: 'timeout' });
  }

  async function timeoutPermission(session: Session, requestId: string, title: string): Promise<void> {
    const pending = session.pendingPermissions.get(requestId);
    if (!pending) return;
    await settlePendingCard(session, pending);
    session.pendingPermissions.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve({ outcome: { outcome: 'selected', optionId: rejectOption(pending.options) } });
    await record(session, 'acp.permission_response', { requestId, timedOut: true });
    // The Inbox has no write API; its `question` category is derived from
    // unresolved comments.md questions, so that is the door (Decision 9).
    try {
      await appendComment({
        ticketDir: session.ticket.ticketDir,
        ticketRef: session.ticket.ticketSlug,
        author: session.agentId,
        type: 'question',
        body:
          `The chat agent asked for permission to run **${title}** and nobody answered within ` +
          `${Math.round(timeouts.permissionMs / 60000)} minutes, so it was denied and the turn moved on. ` +
          `Re-run it from the Chat tab if it should have been allowed.`,
      });
    } catch {
      await record(session, 'system', {
        level: 'warn',
        text: 'A permission request timed out but the Inbox question could not be filed',
      });
    }
  }

  async function onExit(
    session: Session,
    info: { code: number | null; signal: NodeJS.Signals | null },
  ): Promise<void> {
    const client = session.client;
    if (client === null) return; // an orderly close() already accounted for it
    session.client = null;
    session.autoApprove = false;
    clearChatSessionPid(session.key);
    // The adapter's own last words, bounded by the client's stderr ring.
    const stderr = client.stderr().trim().split('\n').slice(-3).join(' ').slice(0, 300);
    await record(session, 'session.exited', {
      text:
        `The ${session.harness.command} adapter exited (code ${info.code ?? 'null'}, signal ${info.signal ?? 'none'})` +
        (stderr ? `: ${stderr}` : ''),
    }, null);
    if (session.acpSessionId) {
      await updateSessionStatus('', session.acpSessionId, 'stopped', iso()).catch(() => false);
    }
    setState(session, 'error', `adapter exited (code ${info.code ?? 'null'})`);
  }

  // --- turns ---------------------------------------------------------------

  function armTurnIdle(session: Session, turn: InFlightTurn): void {
    if (turn.idleTimer) clearTimeout(turn.idleTimer);
    turn.idleTimer = setTimeout(() => {
      void (async () => {
        await record(session, 'system', {
          level: 'warn',
          text: `No activity for ${Math.round(timeouts.turnIdleMs / 60000)} minutes — cancelling the turn`,
        });
        await cancelTurn(session);
      })();
    }, timeouts.turnIdleMs);
    turn.idleTimer.unref?.();
  }

  async function cancelTurn(session: Session): Promise<boolean> {
    const turn = session.inFlight;
    if (!turn || !session.acpSessionId || !session.client) return false;
    turn.cancelled = true;
    await record(session, 'turn.cancel', {}, turn.turnId);
    // A cancel while a permission is pending answers it `cancelled` — the ACP
    // outcome the adapters expect (spike row 07 part B).
    for (const [requestId, pending] of session.pendingPermissions) {
      await settlePendingCard(session, pending);
      clearTimeout(pending.timer);
      pending.resolve({ outcome: { outcome: 'cancelled' } });
      session.pendingPermissions.delete(requestId);
      await record(session, 'acp.permission_response', { requestId, cancelled: true }, turn.turnId);
    }
    for (const [requestId, pending] of session.pendingQuestions) {
      await settlePendingCard(session, pending);
      clearTimeout(pending.timer);
      pending.resolve({ outcome: { outcome: 'cancelled' } });
      session.pendingQuestions.delete(requestId);
      await record(session, 'question.answered', { requestId, by: 'cancel' }, turn.turnId);
    }
    await session.client.cancel(session.acpSessionId).catch(() => {});
    return true;
  }

  function drive(session: Session): Promise<void> {
    // Serialise: two sends arriving together must not both spawn an adapter.
    // The chain must never be broken by a rejection — a dead chain means the
    // queue stops draining and the chat silently stops accepting work — but it
    // must not swallow either, so failures are surfaced before being absorbed.
    session.driving = session.driving
      .then(() => driveOnce(session))
      .catch((err) => {
        console.error(
          `syntaur chat: drive failed for ${session.key}:`,
          err instanceof Error ? err.stack ?? err.message : err,
        );
      });
    return session.driving;
  }

  /**
   * The turn's trigger as the prompt sees it (§2.4): who wrote it, what they
   * wrote, and — for an agent-to-agent hop — where in the chain this turn sits,
   * so a triggered agent knows it was handed the conversation rather than
   * addressed by the human.
   */
  function promptTrigger(
    session: Session,
    entry: { text: string; trigger: TurnTrigger; attachments?: ChatAttachment[] },
    images: Array<{ data: string; mimeType: string }> = [],
  ): TurnPromptTrigger {
    const hadAttachments = (entry.attachments?.length ?? 0) > 0;
    const extras = {
      ...(hadAttachments ? { hadAttachments: true } : {}),
      ...(images.length ? { images } : {}),
    };
    if (entry.trigger.kind === 'human') {
      return { author: 'human', text: entry.text, ts: new Date(now()), ...extras };
    }
    return {
      author: { agentId: entry.trigger.fromAgentId },
      text: entry.text,
      ts: new Date(now()),
      hop: { n: entry.trigger.hop, budget: session.hopBudget },
      ...extras,
    };
  }

  /**
   * The standing context, with the roster: who this agent is and who else is in
   * the room. Sent once per adapter session (§2.4).
   */
  async function buildStanding(
    session: Session,
  ): Promise<{ blocks: ContentBlock[]; fingerprint: string; gen: number }> {
    const gen = session.standingGen;
    const { definitions, participants } = await routingContext(session.ticket);
    const roster = participants.agents
      .map((id) => definitions.find((d) => d.id === id))
      .filter((d): d is AgentDefinition => d !== undefined);
    const blocks = await buildStandingContext({
      definition: session.definition,
      harness: session.harness,
      ticketDir: session.ticket.ticketDir,
      syntaurRoot: syntaurHome(),
      context: {
        projectSlug: session.ticket.projectSlug,
        ticketSlug: session.ticket.ticketSlug,
        ticketDir: session.ticket.ticketDir,
        worktreePath: session.cwd,
        branch: session.branch,
        cwdTier: session.cwdTier,
        agent: session.definition,
        roster,
      },
    });
    const standingMeta = await readTicketStandingMeta(session.ticket.ticketDir);
    return {
      blocks,
      fingerprint: standingFingerprint(session.definition, definitions, participants, standingMeta),
      gen,
    };
  }

  /**
   * The `<chat-history>` delta for this turn, with the trigger itself excluded —
   * it is appended as the last `<chat-event>` and must not be quoted twice.
   */
  async function buildHistory(session: Session, trigger: TurnTrigger) {
    const scope = await ticketScope(session.ticket);
    const excludeItemIds = new Set<string>();
    const excludeTurnIds = new Set<string>();

    if (trigger.kind === 'human') {
      const message = scope.messages.get(trigger.messageId);
      if (message) excludeItemIds.add(message.itemId);
    } else {
      const handoff = scope.handoffs.get(trigger.handoffId);
      if (handoff) {
        excludeItemIds.add(handoff.itemId);
        // The delegator's sealed replies ARE the trigger text, so the whole
        // turn they came from is excluded rather than just the last bubble.
        const source = handoff.triggerItemId ? getChatItem(handoff.triggerItemId) : null;
        if (source?.turnId) excludeTurnIds.add(source.turnId);
      }
    }

    const selection = selectChatHistory({
      items: listChatItemsSince(session.ticket.id, session.lastDeliveredSeq),
      agentId: session.agentId,
      sinceSeq: session.lastDeliveredSeq,
      excludeItemIds,
      excludeTurnIds,
    });

    // The trigger counts as delivered too: it is the last `<chat-event>` of this
    // very prompt. Without it the cursor would stop short of the trigger's own
    // row and the next turn would quote the agent its previous trigger back.
    const triggerSeq =
      trigger.kind === 'human'
        ? (scope.messages.get(trigger.messageId)?.seqFirst ?? null)
        : (scope.handoffs.get(trigger.handoffId)?.seqFirst ?? null);
    const highest = Math.max(selection.highestSeq ?? -1, triggerSeq ?? -1);
    return { ...selection, highestSeq: highest >= 0 ? highest : null };
  }

  /** One internal turn that delivers standing context before a first slash command (Task 2a). */
  async function deliverStandingAck(session: Session): Promise<void> {
    const turnId = randomUUID();
    const startedAt = iso();
    const tokensAtOpen = snapshotOf(session);
    const engagement = openEngagement({
      sessionId: session.acpSessionId!,
      ticketId: session.ticket.id,
      projectSlug: session.ticket.projectSlug,
      ticketSlug: session.ticket.ticketSlug,
      stage: 'chat',
      startedAt,
      tokensAtOpen,
    });
    const turn: InFlightTurn = {
      turnId,
      trigger: { kind: 'human', messageId: `standing:${turnId}` },
      startedAt,
      startedMs: now(),
      engagementId: engagement.id,
      engagementStartedAt: engagement.started_at,
      reportedCumulativeCost: null,
      costAtOpen: session.cumulative.models[modelKey(session)]?.cost ?? 0,
      idleTimer: null,
      maxTimer: null,
      cancelled: false,
      deliveredSeqCandidate: session.lastDeliveredSeq,
    };
    session.inFlight = turn;
    await record(session, 'turn.start', { trigger: turn.trigger, startedAt }, turnId);
    const built = await buildStanding(session);
    const blocks = buildTurnPrompt(
      { author: 'human', text: 'OK', ts: new Date(now()) },
      { standing: built.blocks },
    );
    let response: acp.PromptResponse | null = null;
    let failure: Error | null = null;
    try {
      response = await session.client!.prompt(session.acpSessionId!, blocks);
    } catch (err) {
      failure = err instanceof Error ? err : new Error(String(err));
    }
    if (!failure) await markStandingDelivered(session, built.fingerprint, built.gen);
    await finishTurn(session, turn, response, failure);
  }

  async function driveOnce(session: Session): Promise<void> {
    if (stopping) return;
    if (session.inFlight) return; // Decision 6 — one prompt in flight, always
    const next = session.queue[0];
    if (!next) return;

    try {
      await ensureAdapter(session);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await record(session, 'system', { level: 'error', text: message }, null);
      setState(session, 'error', message);
      // The message stays queued: the adapter never saw it, so a later send (or
      // a fixed PATH / workspace) can still deliver it.
      flush(session);
      return;
    }

    if (session.queue[0] !== next) return; // withdrawn while the adapter came up

    const { participants } = await routingContext(session.ticket);
    const humanCommand =
      next.trigger.kind === 'human' ? detectCommand(next.text, participants.agents) : null;

    // Task 2a: a slash command must be the only prompt block; standing goes in its own turn.
    if (humanCommand && !session.standingSent) {
      await deliverStandingAck(session);
    }

    const turnId = randomUUID();
    const startedAt = iso();
    const tokensAtOpen = snapshotOf(session);
    const engagement = openEngagement({
      sessionId: session.acpSessionId!,
      ticketId: session.ticket.id,
      projectSlug: session.ticket.projectSlug,
      ticketSlug: session.ticket.ticketSlug,
      stage: 'chat',
      startedAt,
      tokensAtOpen,
    });

    const turn: InFlightTurn = {
      turnId,
      trigger: next.trigger,
      startedAt,
      startedMs: now(),
      engagementId: engagement.id,
      engagementStartedAt: engagement.started_at,
      reportedCumulativeCost: null,
      costAtOpen: session.cumulative.models[modelKey(session)]?.cost ?? 0,
      idleTimer: null,
      maxTimer: null,
      cancelled: false,
      deliveredSeqCandidate: null,
    };
    session.inFlight = turn;
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }

    await record(session, 'turn.start', { trigger: next.trigger, startedAt }, turnId);
    // One `user.message.delivered` per target, right after its `turn.start`:
    // the ticket-scope item's `deliveredTo` grows and its state moves
    // queued → partial → sent (Decision 3). The per-agent normalizer never
    // touches that row.
    if (next.trigger.kind === 'human') {
      await recordTicket(
        session.ticket,
        'user.message.delivered',
        { messageId: next.trigger.messageId, agentId: session.agentId, turnId },
        { agentId: HUMAN_AGENT_ID, turnId },
      );
    }
    // Dequeue only now that the turn is committed. Shifting earlier meant any
    // throw between the shift and the send dropped the message with no turn and
    // no trace (finding 5).
    const at = session.queue.indexOf(next);
    if (at >= 0) session.queue.splice(at, 1);
    setState(session, 'running');

    // What this session has not been shown yet (Decision 4). The cursor is
    // TWO-PHASE: the candidate is computed here, with the prompt, and committed
    // only when the turn ends without an error — a prompt that never reached the
    // agent must be re-delivered, not skipped.
    const history = humanCommand ? null : await buildHistory(session, next.trigger);
    turn.deliveredSeqCandidate = humanCommand ? session.lastDeliveredSeq : history!.highestSeq;

    const matchedCommand = humanCommand
      ? session.commands.find((c) => c.name === humanCommand.name) ?? null
      : null;

    const images: Array<{ data: string; mimeType: string }> = [];
    if (next.attachments?.length) {
      for (const att of next.attachments) {
        const file = await readChatAttachmentBase64(session.ticket.ticketDir, att.id);
        if (!file) {
          await record(
            session,
            'system',
            {
              level: 'warn',
              text: `Attachment ${att.name} is missing on disk; sent the text without it`,
            },
            turnId,
          );
          continue;
        }
        images.push({ data: file.data, mimeType: file.mimeType });
      }
    }

    let blocks: ContentBlock[] | null = null;
    let configResponse: acp.SetSessionConfigOptionResponse | null = null;
    let pendingStanding: { fingerprint: string; gen: number } | undefined;
    if (humanCommand) {
      if (matchedCommand?.action.kind === 'set-config') {
        try {
          configResponse = await session.client!.setConfigOption(
            session.acpSessionId!,
            matchedCommand.action.configId,
            matchedCommand.action.value,
          );
          readSessionConfig(session, configResponse);
          if (matchedCommand.action.configId === 'collaboration_mode') {
            session.mode = matchedCommand.action.value;
          }
        } catch (err) {
          await record(session, 'system', {
            level: 'warn',
            text: (err as Error).message,
          });
        }
      } else {
        blocks = buildCommandPrompt(humanCommand.line);
      }
    } else {
      try {
        let standing: ContentBlock[] | undefined;
        if (!session.standingSent) {
          const built = await buildStanding(session);
          standing = built.blocks;
          pendingStanding = { fingerprint: built.fingerprint, gen: built.gen };
        }
        blocks = buildTurnPrompt(promptTrigger(session, next, images), { standing, history: history! });
      } catch (err) {
        blocks = buildTurnPrompt(promptTrigger(session, next, images), { history: history! });
        await record(session, 'system', {
          level: 'warn',
          text: `Could not build the standing context: ${(err as Error).message}`,
        });
      }
    }

    armTurnIdle(session, turn);
    turn.maxTimer = setTimeout(() => {
      void (async () => {
        await record(session, 'system', {
          level: 'warn',
          text: `Turn exceeded ${Math.round(timeouts.turnMaxMs / 60000)} minutes — cancelling`,
        });
        await cancelTurn(session);
      })();
    }, timeouts.turnMaxMs);
    turn.maxTimer.unref?.();

    let response: acp.PromptResponse | null = null;
    let failure: Error | null = null;
    if (humanCommand && matchedCommand?.action.kind === 'set-config') {
      const label = `/${humanCommand.name} → ${matchedCommand.action.configId} = ${matchedCommand.action.value}`;
      await record(session, 'system', { level: 'info', text: label });
      response = { stopReason: 'end_turn' } as acp.PromptResponse;
    } else {
      try {
        response = await session.client!.prompt(session.acpSessionId!, blocks!);
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err));
      }
    }

    if (!failure && pendingStanding) {
      await markStandingDelivered(session, pendingStanding.fingerprint, pendingStanding.gen);
    }

    try {
      await finishTurn(session, turn, response, failure);
    } catch (err) {
      // The turn is committed: it MUST be sealed and its engagement closed, or
      // the next start trips the one-open-per-session index.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`syntaur chat: finishTurn failed for ${session.key}:`, err);
      session.inFlight = null;
      closeEngagementById({
        id: turn.engagementId,
        startedAt: turn.engagementStartedAt,
        closeReason: 'error',
        tokensAtClose: snapshotOf(session),
        endedAt: iso(),
      });
      await record(session, 'system', { level: 'error', text: message }, null).catch(() => {});
      setState(session, 'error', message);
      flush(session);
    }
    void drive(session);
  }

  async function finishTurn(
    session: Session,
    turn: InFlightTurn,
    response: acp.PromptResponse | null,
    failure: Error | null,
  ): Promise<void> {
    if (turn.idleTimer) clearTimeout(turn.idleTimer);
    if (turn.maxTimer) clearTimeout(turn.maxTimer);
    session.inFlight = null;
    session.lastTurnAt = iso();

    const usage = response?.usage ?? null;
    // claude reports a cumulative session cost; this turn's cost is the delta.
    // codex reports none, so its buckets are priced instead (0 until OpenAI
    // rates land in MODEL_PRICING).
    const cost =
      turn.reportedCumulativeCost !== null
        ? Math.max(0, turn.reportedCumulativeCost - turn.costAtOpen)
        : priceUsage(session, usage);
    addUsage(session, usage, cost, turn.reportedCumulativeCost);

    const stopReason = failure ? 'error' : (response?.stopReason ?? 'end_turn');
    const durationMs = Math.max(0, now() - turn.startedMs);
    await record(
      session,
      'turn.end',
      {
        stopReason,
        endedAt: iso(),
        durationMs,
        usage,
        cost,
        ...(failure ? { error: failure.message } : {}),
      },
      turn.turnId,
    );

    closeEngagementById({
      id: turn.engagementId,
      startedAt: turn.engagementStartedAt,
      closeReason: failure ? 'error' : stopReason === 'cancelled' ? 'cancelled' : 'turn_end',
      // A failed turn carried no `usage`, so nothing was added to the cumulative
      // snapshot and the window prices at zero — which is what an unpriceable
      // turn should cost.
      tokensAtClose: snapshotOf(session),
      endedAt: iso(),
    });

    // Commit the delivery cursor for every stop reason but `error`: the agent
    // saw the prompt even if the turn was cancelled, but a prompt that FAILED
    // never reached it, so the next turn re-delivers (Decision 4).
    if (stopReason !== 'error' && turn.deliveredSeqCandidate !== null) {
      session.lastDeliveredSeq = Math.max(session.lastDeliveredSeq, turn.deliveredSeqCandidate);
    }

    await recordUsageEvent(session);
    persistSession(session);
    flush(session);

    if (!failure && stopReason === 'end_turn') {
      await writeTurnProgress(session, turn, durationMs);
    }

    // A cancelled or failed turn never hops: there is no sealed reply to hand
    // on, and inventing one would restart a chain the human just stopped.
    let hopped = false;
    if (!failure && stopReason !== 'cancelled') {
      try {
        const routeResult = await routeReply(session, turn);
        hopped = routeResult.hopped;
      } catch (err) {
        await record(session, 'system', {
          level: 'warn',
          text: `Could not route this reply to another agent: ${(err as Error).message}`,
        }, null);
        flush(session);
      }
    }

    if (!failure && stopReason === 'end_turn' && turn.trigger.kind === 'human' && !hopped) {
      try {
        const turnItems = listChatItemsByTurn(session.ticket.id, turn.turnId);
        const replies = turnItems.filter(
          (item): item is AgentMessageItem => item.type === 'agent.message' && item.sealed,
        );
        const text = replies.map((reply) => reply.text).join('\n\n');
        const question = detectOpenQuestion(text);
        if (question && replies.length > 0) {
          const lastReply = replies[replies.length - 1];
          await fileChatQuestion(
            session,
            { kind: 'reply', itemId: lastReply.itemId, turnId: turn.turnId },
            question,
          );
        }
      } catch (err) {
        try {
          await record(session, 'system', {
            level: 'warn',
            text: `Could not file the Inbox question: ${(err as Error).message}`,
          });
          flush(session);
        } catch {
          /* swallow */
        }
      }
    }

    if (session.client?.alive()) setState(session, 'ready');
    armSessionIdle(session);
  }

  /**
   * What a sealed reply hands on (§5.6). The router decides; this only gathers
   * the evidence and records the result: the turn's sealed `agent.message`
   * text, whether the turn produced any work card, and the trigger it was
   * answering. Reading the turn's items back from the index rather than
   * tracking them live is deliberate — the index is exactly what the normalizer
   * produced, folds and retractions included.
   */
  async function routeReply(session: Session, turn: InFlightTurn): Promise<{ hopped: boolean }> {
    const { definitions, participants } = await routingContext(session.ticket);
    session.hopBudget = participants.hopBudget ?? DEFAULT_HOP_BUDGET;

    const turnItems = listChatItemsByTurn(session.ticket.id, turn.turnId);
    const replies = turnItems.filter(
      (item): item is AgentMessageItem => item.type === 'agent.message' && item.sealed,
    );
    const hadToolActivity = turnItems.some((item) => item.type === 'agent.work');
    const text = replies.map((reply) => reply.text).join('\n\n');

    const parsed = parseMentions(text, participants.agents);
    const result = routeAgentReply({
      fromAgentId: session.agentId,
      mentions: parsed.mentioned,
      unknown: parsed.unknown,
      hadToolActivity,
      trigger: turn.trigger,
      participants,
      definitions,
    });

    for (const notice of result.notices) {
      await recordTicket(
        session.ticket,
        'route.notice',
        { level: 'warn', text: notice },
        { agentId: SYSTEM_AGENT_ID },
      );
    }

    const routingNotices: string[] = [];
    const activeHops: Array<{ hop: (typeof result.hops)[number]; target: Session }> = [];
    for (const hop of result.hops) {
      try {
        activeHops.push({ hop, target: await ensureSession(session.ticket, hop.toAgentId) });
      } catch (err) {
        if (err instanceof ChatSendError && err.status === 409) {
          routingNotices.push(`@${hop.toAgentId} was detached while the hand-off was being routed`);
          continue;
        }
        throw err;
      }
    }

    const { definitions: defsAfter } = await loadDefs();
    const { participants: participantsNow } = await readParticipantsDetailed(
      session.ticket.ticketDir,
      defsAfter,
    );

    const triggerItemId = replies[replies.length - 1]?.itemId ?? null;
    for (const { hop, target } of activeHops) {
      if (!participantsNow.agents.includes(target.agentId)) {
        routingNotices.push(`@${target.agentId} was detached while the hand-off was being routed`);
        continue;
      }
      const handoffId = randomUUID();
      await recordTicket(
        session.ticket,
        'handoff',
        {
          handoffId,
          fromAgentId: session.agentId,
          toAgentId: hop.toAgentId,
          triggerItemId,
          text,
          hop: hop.hop,
          budget: participants.hopBudget ?? DEFAULT_HOP_BUDGET,
        },
        { agentId: session.agentId },
      );
      target.hopBudget = session.hopBudget;
      enqueue(target, {
        text,
        trigger: { kind: 'handoff', handoffId, fromAgentId: session.agentId, hop: hop.hop },
      });
      void drive(target);
    }

    for (const notice of routingNotices) {
      await recordTicket(
        session.ticket,
        'route.notice',
        { level: 'warn', text: notice },
        { agentId: SYSTEM_AGENT_ID },
      );
    }

    return { hopped: activeHops.length > 0 };
  }

  /**
   * Add a turn to an agent's queue, at most once per trigger. One trigger is one
   * turn: a message is delivered to a target once and a handoff is answered
   * once, whether it arrived from the router or from crash recovery.
   */
  function enqueue(
    session: Session,
    entry: { text: string; trigger: TurnTrigger; attachments?: ChatAttachment[] },
  ): boolean {
    const key = triggerKey(entry.trigger);
    if (session.queue.some((queued) => triggerKey(queued.trigger) === key)) return false;
    if (session.inFlight && triggerKey(session.inFlight.trigger) === key) return false;
    session.queue.push(entry);
    emitSession(session);
    return true;
  }

  // --- usage (Decision 10) -------------------------------------------------

  /**
   * The key a session's cumulative tokens accumulate under. The adapter's
   * reported model wins; failing that, an existing sole key in the persisted
   * snapshot is reused so a restart cannot split one session's cost across two
   * keys; the harness id is the last resort.
   */
  function modelKey(session: Session): string {
    if (session.model) return session.model;
    const existing = Object.keys(session.cumulative.models);
    if (existing.length === 1) return existing[0];
    return session.harness.id;
  }

  function snapshotOf(session: Session): TokenSnapshot {
    return {
      models: structuredClone(session.cumulative.models),
      collectorRunAt: null,
      capturedAt: new Date(now()).toISOString(),
    };
  }

  /**
   * Fold a turn into the session's cumulative snapshot.
   *
   * Tokens always accumulate. Cost is different per harness (Decision 11): when
   * the adapter reports a cumulative figure (claude) it is authoritative and is
   * stored ABSOLUTELY — adding it would compound a running total and inflate the
   * ticket's cost several-fold. Otherwise (codex) the priced per-turn value
   * accumulates.
   */
  function addUsage(
    session: Session,
    usage: acp.Usage | null,
    cost: number | null,
    reportedCumulativeCost: number | null,
  ): void {
    const key = modelKey(session);
    const current = session.cumulative.models[key] ?? { ...EMPTY_TOKENS };
    session.cumulative.models[key] = {
      input: current.input + (usage?.inputTokens ?? 0),
      output: current.output + (usage?.outputTokens ?? 0),
      cacheCreation: current.cacheCreation + (usage?.cachedWriteTokens ?? 0),
      cacheRead: current.cacheRead + (usage?.cachedReadTokens ?? 0),
      total: current.total + (usage?.totalTokens ?? 0),
      cost:
        reportedCumulativeCost !== null
          ? Math.max(current.cost, reportedCumulativeCost)
          : current.cost + (cost ?? 0),
    };
    session.cumulative.capturedAt = new Date(now()).toISOString();
  }

  /** codex reports no cost; price its buckets when a rate exists. */
  function priceUsage(session: Session, usage: acp.Usage | null): number | null {
    if (!usage) return null;
    return (
      priceForModel(modelKey(session), {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cacheCreationTokens: usage.cachedWriteTokens ?? 0,
        cacheReadTokens: usage.cachedReadTokens ?? 0,
      }) ?? 0
    );
  }

  /**
   * Usage rows (Decision 10). For claude the broker writes NONE — ccusage
   * already records the underlying Claude Code session under this same id, and
   * writing here would double it. For codex there is no collector, so the
   * session's CUMULATIVE totals are upserted at every turn close: `upsertEvent`
   * keeps `MAX(existing, incoming)` per column, so a per-turn delta would be
   * silently discarded.
   */
  async function recordUsageEvent(session: Session): Promise<void> {
    if (!session.acpSessionId) return;
    const usageSpec = session.harness.usage;
    if (usageSpec.kind === 'none') {
      if (!session.unpricedNoticeSent) {
        session.unpricedNoticeSent = true;
        await record(
          session,
          'system',
          {
            level: 'info',
            text: 'cursor reports no usage; this chat\'s turns are not costed',
          },
          null,
        );
      }
      return;
    }
    if (usageSpec.kind === 'adapter-cost' && session.harness.id === 'claude') {
      // ccusage already records the underlying Claude Code session under this id.
      return;
    }
    const key = modelKey(session);
    const totals = session.cumulative.models[key];
    if (!totals) return;
    const tool =
      usageSpec.kind === 'tokens'
        ? session.harness.id === 'codex'
          ? 'acp-codex'
          : 'acp-cursor'
        : 'acp-cursor';
    if (
      usageSpec.kind === 'tokens' &&
      !session.unpricedNoticeSent &&
      priceForModel(key, ZERO_BUCKETS) === null
    ) {
      session.unpricedNoticeSent = true;
      await record(
        session,
        'system',
        {
          level: 'info',
          text: `No price list entry for ${key}, so this chat's turns are costed at $0. Token counts are still recorded.`,
        },
        null,
      );
    }
    try {
      upsertEvent({
        sessionId: session.acpSessionId,
        model: key,
        tool,
        eventTs: iso(),
        inputTokens: totals.input,
        outputTokens: totals.output,
        cacheCreationTokens: totals.cacheCreation,
        cacheReadTokens: totals.cacheRead,
        totalTokens: totals.total,
        totalCost: totals.cost,
        cwd: session.cwd,
        projectSlug: session.ticket.projectSlug ?? '',
        ticketSlug: session.ticket.id,
        rawJson: null,
      });
    } catch {
      // The usage db may not be initialised in a bare test process; never let a
      // usage write fail a turn.
    }
  }

  // --- idle teardown -------------------------------------------------------

  function armSessionIdle(session: Session): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (!session.client) return;
    session.idleTimer = setTimeout(() => {
      void tearDownIdle(session);
    }, timeouts.sessionIdleMs);
    session.idleTimer.unref?.();
  }

  async function tearDownIdle(session: Session): Promise<void> {
    if (session.inFlight || !session.client) return;
    const client = session.client;
    session.client = null;
    session.autoApprove = false;
    await client.close();
    clearChatSessionPid(session.key);
    await record(session, 'session.idle', {}, null);
    if (session.acpSessionId) {
      await updateSessionStatus('', session.acpSessionId, 'stopped', iso()).catch(() => false);
    }
    setState(session, 'idle');
  }

  // --- public surface ------------------------------------------------------

  async function fileRecord(
    ticket: ResolvedTicket,
    itemId: string,
    record: FileChatRecordInput,
  ): Promise<FiledChatRecord> {
    const item = getChatItem(itemId);
    if (!item || item.ticketId !== ticket.id) {
      throw new ChatSendError('No such message', 404);
    }

    const fileable =
      (item.type === 'user.message' &&
        (item as UserMessageItem).state !== 'withdrawn' &&
        (item as UserMessageItem).state !== 'replayed') ||
      (item.type === 'agent.message' && item.sealed);

    if (!fileable) {
      throw new ChatSendError('Only a sent message or a sealed reply can be filed', 400);
    }

    const filed = await withRecordLock(ticket.ticketDir, () =>
      fileChatRecord({
        ticketDir: ticket.ticketDir,
        ticketRef: ticket.ticketSlug,
        record,
        source: { agentId: item.agentId, ts: item.ts },
      }),
    );

    const source =
      item.agentId === HUMAN_AGENT_ID ? 'your message' : `@${item.agentId}'s reply`;
    const text = `Filed ${source} as ${filed.label}`;
    try {
      await recordTicket(ticket, 'system', { level: 'info', text }, {
        agentId: SYSTEM_AGENT_ID,
      });
    } catch (err) {
      console.error('syntaur chat: filed record but could not write system row:', err);
    }

    return filed;
  }

  return {
    async send({ ticket, agentId, text, attachments }) {
      if (!ticket) throw new ChatSendError('No ticket target', 400);
      if (!text.trim() && !attachments?.length) throw new ChatSendError('Message is empty', 400);
      const { definitions, participants } = await routingContext(ticket);
      if (definitions.length === 0) throw new ChatSendError('No agent definitions are available', 404);
      if (attachments?.length && detectCommand(text, participants.agents)) {
        throw new ChatSendError('A /command cannot carry attachments', 400);
      }

      // The composer's explicit pick counts as a mention (Decision 2), ahead of
      // anything the text names, so "send to @implementer" from the picker and
      // "@implementer do it" in the text route identically.
      const parsed = parseMentions(text, participants.agents);
      const unknown = [...parsed.unknown];
      let mentions = parsed.mentioned;
      if (agentId) {
        if (!definitions.some((d) => d.id === agentId)) {
          throw new ChatSendError(`No agent definition ${JSON.stringify(agentId)}`, 404);
        }
        if (participants.agents.includes(agentId)) {
          mentions = [agentId, ...mentions.filter((id) => id !== agentId)];
        } else if (!unknown.includes(agentId)) {
          unknown.push(agentId);
        }
      }

      const { targets, notices } = routeHuman({ mentions, unknown, participants, definitions });

      const targetSessions: Session[] = [];
      const routingNotices = [...notices];
      for (const target of targets) {
        try {
          targetSessions.push(await ensureSession(ticket, target));
        } catch (err) {
          if (err instanceof ChatSendError && err.status === 409) {
            routingNotices.push(`@${target} was detached while the message was being routed`);
            continue;
          }
          throw err;
        }
      }
      if (targetSessions[0]) await resolveCwd(targetSessions[0]);

      const { definitions: defsAfter } = await loadDefs();
      const { participants: participantsNow } = await readParticipantsDetailed(
        ticket.ticketDir,
        defsAfter,
      );
      const activeSessions: Session[] = [];
      for (const session of targetSessions) {
        if (participantsNow.agents.includes(session.agentId)) {
          activeSessions.push(session);
        } else {
          routingNotices.push(`@${session.agentId} was detached while the message was being routed`);
        }
      }

      const messageId = randomUUID();
      const deliveredTargets = activeSessions.map((s) => s.agentId);
      await recordTicket(ticket,
        'user.message',
        {
          messageId,
          text,
          state: 'queued',
          mentions,
          targets: deliveredTargets,
          unknown,
          ...(attachments?.length ? { attachments } : {}),
        },
        { agentId: HUMAN_AGENT_ID },
      );
      for (const notice of routingNotices) {
        await recordTicket(ticket,
          'route.notice',
          { level: 'warn', text: notice },
          { agentId: SYSTEM_AGENT_ID },
        );
      }
      if (deliveredTargets.length > 0) {
        void resolveChatQuestions(ticket, (c) =>
          deliveredTargets.some((agentId) => byAgentAndKind(agentId, ['reply'])(c)),
        );
      }
      if (targets.length === 0) {
        await recordTicket(ticket,
          'route.notice',
          {
            level: 'warn',
            text: 'No agent is attached to this ticket, so nothing was started. Attach one from “Manage agents”.',
          },
          { agentId: SYSTEM_AGENT_ID },
        );
      }

      for (const session of activeSessions) {
        enqueue(session, {
          text,
          trigger: { kind: 'human', messageId },
          ...(attachments?.length ? { attachments } : {}),
        });
        void drive(session);
      }
      return { messageId };
    },

    async withdraw(ticket, messageId) {
      // A fan-out message sits in EVERY target's queue, so all of them are
      // searched — and after a restart none of them are in memory until they
      // are materialised (round 1, finding 4).
      const all = await ensureTicketSessions(ticket, { autoDrive: false });
      const scope = await ticketScope(ticket);
      const item = scope.messages.get(messageId);
      // Once any target has started, the message has reached an agent and
      // cannot be unsent.
      if ((item?.deliveredTo ?? []).length > 0) return false;

      const matches = (entry: { trigger: TurnTrigger }) =>
        entry.trigger.kind === 'human' && entry.trigger.messageId === messageId;
      let removed = 0;
      for (const session of all) {
        const before = session.queue.length;
        session.queue = session.queue.filter((entry) => !matches(entry));
        if (session.queue.length !== before) {
          removed += before - session.queue.length;
          emitSession(session);
        }
      }
      if (removed === 0) return false;
      await recordTicket(ticket,
        'user.message',
        { messageId, text: '', state: 'withdrawn' },
        { agentId: HUMAN_AGENT_ID },
      );
      return true;
    },

    async cancel(ticket, agentId) {
      // With an id, cancel that agent; without one, cancel every agent that is
      // mid-turn — a fan-out or a hop chain can have several running at once.
      const running = (await ensureTicketSessions(ticket)).filter(
        (s) => s.inFlight !== null && (!agentId || s.agentId === agentId),
      );
      if (running.length === 0) return false;
      const results = await Promise.all(running.map((session) => cancelTurn(session)));
      return results.some(Boolean);
    },

    async answerPermission(ticket, requestId, optionId, opts) {
      const session = (await ensureTicketSessions(ticket)).find((s) =>
        s.pendingPermissions.has(requestId),
      );
      const pending = session?.pendingPermissions.get(requestId);
      if (!session || !pending) return false;
      await settlePendingCard(session, pending);
      session.pendingPermissions.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve({ outcome: { outcome: 'selected', optionId } });
      await record(session, 'acp.permission_response', { requestId, optionId, by: 'human' });
      if (opts?.allowAllSession) {
        session.autoApprove = true;
        await record(session, 'system', {
          level: 'info',
          text: `Auto-approving @${session.agentId}'s permission requests for the rest of this session`,
        });
        for (const [otherId, other] of [...session.pendingPermissions.entries()]) {
          if (otherId === requestId) continue;
          await settlePendingCard(session, other);
          session.pendingPermissions.delete(otherId);
          clearTimeout(other.timer);
          const autoOptionId = allowOption(other.options);
          other.resolve({ outcome: { outcome: 'selected', optionId: autoOptionId } });
          await record(session, 'acp.permission_response', {
            requestId: otherId,
            optionId: autoOptionId,
            by: 'auto',
          });
        }
      }
      flush(session);
      return true;
    },

    async answerQuestion(ticket, requestId, answer) {
      const session = (await ensureTicketSessions(ticket)).find((s) =>
        s.pendingQuestions.has(requestId),
      );
      const pending = session?.pendingQuestions.get(requestId);
      if (!session || !pending) return false;
      const question = pending.questions[0];
      if (!answer.optionId && !answer.text) return false;
      session.pendingQuestions.delete(requestId);
      clearTimeout(pending.timer);
      await settlePendingCard(session, pending);
      if (answer.optionId) {
        pending.resolve({
          outcome: {
            outcome: 'answered',
            answers: [{ questionId: question?.id ?? 'q1', selectedOptionIds: [answer.optionId] }],
          },
        });
        await record(session, 'question.answered', { requestId, optionId: answer.optionId, by: 'human' });
      } else {
        pending.resolve({
          outcome: {
            outcome: 'answered',
            answers: [{ questionId: question?.id ?? 'q1', selectedOptionIds: [answer.text!] }],
          },
        });
        await record(session, 'question.answered', { requestId, text: answer.text, by: 'human' });
      }
      flush(session);
      return true;
    },

    async getSession(ticket, agentId) {
      try {
        const session = await ensureSession(ticket, agentId ?? null);
        return summarize(session);
      } catch (err) {
        if (err instanceof ChatSendError && (err.status === 404 || err.status === 409)) return null;
        throw err;
      }
    },

    listAgents: () => loadDefs(),

    harnesses: () => harnessSummaries(),

    refreshHarness,

    testAgent,

    saveAgent,

    deleteAgent,

    agentSummaries,

    async getParticipants(ticket) {
      const { definitions } = await loadDefs();
      const { participants: raw, dropped } = await readParticipantsDetailed(
        ticket.ticketDir,
        definitions,
      );
      const participants = await repairDroppedParticipants(
      ticket,
        dropped,
        raw,
        definitions,
      );
      return {
        participants,
        agents: definitions.map((d) => toAgentSummary(d, commandResolver)),
      };
    },

    async setParticipants(ticket, next) {
      const { definitions } = await loadDefs();
      // Materialise every session the CURRENT set knows about before the write,
      // so an agent about to be detached is reachable even if nothing has
      // touched it since the dashboard started.
      const before = await ensureTicketSessions(ticket);
      const previous = await readParticipants(ticket.ticketDir, definitions);
      const participants = await writeParticipants(ticket.ticketDir, next, definitions);
      if (participantAgentsChanged(previous.agents, participants.agents)) {
        for (const session of before) invalidateStanding(session);
      }
      const detached = previous.agents.filter((id) => !participants.agents.includes(id));
      for (const agentId of detached) {
        const session = before.find((s) => s.agentId === agentId);
        if (session) await detachSession(session);
      }
      const agents = definitions.map((d) => toAgentSummary(d, commandResolver));
      options.broadcast({
        type: 'chat-participants',
        projectSlug: ticket.projectSlug,
        ticketSlug: ticket.ticketSlug,
          timestamp: iso(),
          payload: {
            ticketId: ticket.id, participants, agents },
      });
      return { participants, agents };
    },

    items: (ticket, opts) => listChatItems(ticket.id, opts),

    fileRecord,

    async reindex(ticket) {
      // Imported here rather than at the top: the store imports the normalizer,
      // and the broker only needs the rebuild on this one path.
      const { rebuildChatIndex } = await import('./store.js');
      const result = await rebuildChatIndex(ticket.ticketDir, ticket.id);
      return { events: result.events, items: result.items };
    },

    async stopAll() {
      stopping = true;
      // Join every construction in flight first. A session still inside
      // `buildSession` would otherwise finish after this pass and publish itself
      // into a map nobody walks again; `stopping` is already true, so each one
      // shuts itself down instead of publishing. Loop because a construction can
      // start one more time before the flag is observed.
      for (let guard = 0; guard < 10 && constructing.size > 0; guard += 1) {
        await Promise.allSettled([...constructing.values()]);
      }
      for (const session of sessions.values()) {
        if (session.flushTimer) clearTimeout(session.flushTimer);
        if (session.idleTimer) clearTimeout(session.idleTimer);

        const turn = session.inFlight;
        if (turn && session.client && session.acpSessionId) {
          await cancelTurn(session).catch(() => false);
          // Give the cancelled prompt a moment to resolve so its own turn.end
          // wins; seal it ourselves if it does not.
          await Promise.race([
            waitFor(() => session.inFlight === null, timeouts.shutdownGraceMs),
            sleep(timeouts.shutdownGraceMs),
          ]);
        }
        if (session.inFlight) {
          const open = session.inFlight;
          session.inFlight = null;
          if (open.idleTimer) clearTimeout(open.idleTimer);
          if (open.maxTimer) clearTimeout(open.maxTimer);
          await record(session, 'turn.end', {
            stopReason: 'cancelled',
            endedAt: iso(),
            durationMs: Math.max(0, now() - open.startedMs),
          }, open.turnId);
          closeEngagementById({
            id: open.engagementId,
            startedAt: open.engagementStartedAt,
            closeReason: 'shutdown',
            tokensAtClose: snapshotOf(session),
            endedAt: iso(),
          });
        }

        for (const [requestId, pending] of session.pendingPermissions) {
          await settlePendingCard(session, pending);
          clearTimeout(pending.timer);
          pending.resolve({ outcome: { outcome: 'cancelled' } });
          session.pendingPermissions.delete(requestId);
          await record(session, 'acp.permission_response', { requestId, cancelled: true });
        }
        for (const [requestId, pending] of session.pendingQuestions) {
          await settlePendingCard(session, pending);
          clearTimeout(pending.timer);
          pending.resolve({ outcome: { outcome: 'cancelled' } });
          session.pendingQuestions.delete(requestId);
          await record(session, 'question.answered', { requestId, by: 'cancel' });
        }

        if (session.client) {
          await record(session, 'system', { level: 'info', text: 'Dashboard stopped' }, null);
          const client = session.client;
          session.client = null;
          await client.close().catch(() => {});
        }
        session.state = 'stopped';
        persistSession(session);
        if (session.acpSessionId) {
          await updateSessionStatus('', session.acpSessionId, 'stopped', iso()).catch(() => false);
        }
      }
      sessions.clear();
    },
  };
}

// --- helpers ---------------------------------------------------------------

/**
 * A `turn.start`'s trigger. Phase-2 log lines carry a flat `messageId` and no
 * `trigger`; they are read as the human message they were (Decision 3).
 */
/** One line of a message, for a notice that has to stay readable. */
function firstLineOf(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function triggerKey(trigger: TurnTrigger): string {
  return trigger.kind === 'human' ? `human:${trigger.messageId}` : `handoff:${trigger.handoffId}`;
}

function triggerOf(event: ChatEvent): TurnTrigger | null {
  const payload = (event.payload ?? {}) as Partial<TurnStartPayload>;
  if (payload.trigger) return payload.trigger;
  if (payload.messageId) return { kind: 'human', messageId: payload.messageId };
  return null;
}

/**
 * The option to answer with when denying (Decision 9). codex offers no
 * `decline`, only its `cancel` decision under `reject_once`, so the fallbacks
 * matter.
 */
function rejectOption(options: acp.PermissionOption[]): string {
  return (
    options.find((o) => o.kind === 'reject_once')?.optionId ??
    options.find((o) => o.kind === 'reject_always')?.optionId ??
    options[0]?.optionId ??
    'reject'
  );
}

/** The option to answer with when auto-approving (Decision 3). */
function allowOption(options: acp.PermissionOption[]): string {
  return (
    options.find((o) => o.kind === 'allow_once')?.optionId ??
    options.find((o) => o.kind === 'allow_always')?.optionId ??
    options[0]?.optionId ??
    'allow'
  );
}

const defaultClientFactory: ClientFactory = (input) =>
  spawnAcpClient({
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    env: input.env,
    onUpdate: input.onUpdate,
    onPermissionRequest: input.onPermissionRequest,
    onExtRequest: input.onExtRequest,
    onExtNotification: input.onExtNotification,
    onExit: input.onExit,
  });

function parseSnapshot(json: string | null | undefined): TokenSnapshot | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as TokenSnapshot;
  } catch {
    return null;
  }
}

const sleep = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
}
