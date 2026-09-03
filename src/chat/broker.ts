/**
 * The session broker — one ACP client per (assignment, agent), and the only
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
 *    `detached`, with `cwd` = the assignment worktree; a dashboard restart takes
 *    it with it (stdin EOF), and the next message resumes the ACP session. A
 *    failed resume falls back to `session/new` plus a `system` row and re-sends
 *    the standing context.
 *  - **Standing context once per adapter session** (§2.4). Later turns carry
 *    only the new user message; after a resume the agent still holds it.
 *  - **Engagement snapshots are built here, not read from the collector**
 *    (Decision 10). Assignment cost is the per-model `cost` delta between an
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
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import type * as acp from '@agentclientprotocol/sdk';
import type { ResolvedAssignment } from '../utils/assignment-resolver.js';
import { extractFrontmatter, getNestedField } from '../dashboard/parser.js';
import { resolveChatCwd, type CwdTier } from './chat-cwd.js';
import { appendComment } from '../lifecycle/comment-append.js';
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
  getChatItem,
  getChatSession,
  listChatItems,
  listChatItemsByTurn,
  listChatItemsSince,
  listChatSessions,
  upsertChatSession,
} from '../db/chat-db.js';
import { adapterVersion as readAdapterVersion, spawnAcpClient, type AcpClient } from './acp-client.js';
import { loadAgentDefinitions, resolveAgent, toAgentSummary } from './agents.js';
import { readParticipants, writeParticipants } from './participants.js';
import { DEFAULT_HOP_BUDGET, parseMentions, routeAgentReply, routeHuman } from './router.js';
import { HARNESSES, probeAuth, resolveCommand } from './harnesses.js';
import { ChatNormalizer } from './normalizer.js';
import { applyProfile, newSessionMeta, profileEnv, resolveSessionProfile, serializeProfile } from './profile.js';
import {
  buildStandingContext,
  buildTurnPrompt,
  selectChatHistory,
  type TurnPromptTrigger,
} from './prompt-framing.js';
import { openChatLog, type ChatLog } from './store.js';
import { HUMAN_AGENT_ID, SYSTEM_AGENT_ID, pin } from './types.js';
import type {
  AgentDefinition,
  AgentMessageItem,
  ChatAgentSummary,
  ChatEvent,
  ChatEventKind,
  HandoffPayload,
  PermissionRequestPayload,
  PermissionResponsePayload,
  TurnStartPayload,
  TurnTrigger,
  HandoffItem,
  UserMessageItem,
  UserMessagePayload,
  ChatItem,
  ChatSessionState,
  ChatSessionSummary,
  ContentBlock,
  Harness,
  HarnessSpec,
  ItemPatch,
  Participants,
  SessionProfile,
} from './types.js';

// --- knobs -----------------------------------------------------------------

export interface BrokerTimeouts {
  /** How long a pending permission waits before it is rejected and filed (Decision 9). */
  permissionMs: number;
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
}

export const DEFAULT_TIMEOUTS: BrokerTimeouts = {
  permissionMs: 5 * 60_000,
  turnIdleMs: 10 * 60_000,
  turnMaxMs: 60 * 60_000,
  sessionIdleMs: 10 * 60_000,
  flushMs: 50,
  shutdownGraceMs: 2_000,
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
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
}

export type ClientFactory = (input: ClientFactoryInput) => AcpClient;

export interface BrokerBroadcast {
  (message: {
    type: 'chat-item' | 'chat-session' | 'chat-participants';
    projectSlug?: string | null;
    assignmentSlug?: string;
    timestamp: string;
    payload: unknown;
  }): void;
}

export interface CreateChatBrokerOptions {
  projectsDir: string;
  assignmentsDir: string;
  broadcast: BrokerBroadcast;
  /** Injected by tests to wire an in-process fake agent instead of a subprocess. */
  clientFactory?: ClientFactory;
  /** Injected by tests; defaults to the machine's `~/.syntaur`. */
  syntaurHome?: string;
  clock?: { now(): number };
  timeouts?: Partial<BrokerTimeouts>;
  /** Routing knobs; `participants.json` overrides `hopBudget` per assignment. */
  routing?: { hopBudget?: number };
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
  send(input: { assignment: ResolvedAssignment; agentId?: string | null; text: string }): Promise<{
    messageId: string;
  }>;
  withdraw(assignment: ResolvedAssignment, messageId: string): Promise<boolean>;
  cancel(assignment: ResolvedAssignment, agentId?: string | null): Promise<boolean>;
  answerPermission(
    assignment: ResolvedAssignment,
    requestId: string,
    optionId: string,
  ): Promise<boolean>;
  getSession(
    assignment: ResolvedAssignment,
    agentId?: string | null,
  ): Promise<ChatSessionSummary | null>;
  listAgents(): Promise<{ definitions: AgentDefinition[]; errors: string[] }>;
  /** The assignment's attached agents, default and hop budget (Decision 1). */
  getParticipants(
    assignment: ResolvedAssignment,
  ): Promise<{ participants: Participants; agents: ChatAgentSummary[] }>;
  /** Validate, persist and broadcast a new participant set. */
  setParticipants(
    assignment: ResolvedAssignment,
    next: Participants,
  ): Promise<{ participants: Participants; agents: ChatAgentSummary[] }>;
  items(assignment: ResolvedAssignment, opts: { beforeSeq?: number; limit?: number }): ChatItem[];
  reindex(assignment: ResolvedAssignment): Promise<{ events: number; items: number }>;
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
}

interface Session {
  key: string;
  assignment: ResolvedAssignment;
  agentId: string;
  definition: AgentDefinition;
  harness: HarnessSpec;
  profile: SessionProfile;
  log: ChatLog;
  normalizer: ChatNormalizer;
  client: AcpClient | null;
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
  queue: Array<{ text: string; trigger: TurnTrigger }>;
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
  permissionSeq: number;
  cumulative: TokenSnapshot;
  /** One "no rate for <model>" notice per session, not one per turn. */
  unpricedNoticeSent: boolean;
  lastTurnAt: string | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  pendingPatches: Map<string, ItemPatch>;
  error: string | null;
  /** Serialises `drive` so two sends cannot both spawn an adapter. */
  driving: Promise<void>;
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
export function assignmentScopeKey(assignmentId: string): string {
  return `${assignmentId}:@assignment`;
}

/** The assignment scope's live normalizer, plus what the broker reads back. */
interface AssignmentScope {
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
   * One `ChatLog` per assignment DIRECTORY, not per session (finding 4). Every
   * agent on an assignment appends to the same `events.jsonl`, and each log
   * instance owns its own `seq` counter and append chain — two instances would
   * hand out duplicate `seq` values and interleave torn lines. The promise is
   * cached (not the resolved log) so concurrent `ensureSession` calls await the
   * same open rather than racing to create two.
   */
  const logs = new Map<string, Promise<ChatLog>>();
  /** One assignment scope per assignment directory (Decision 3). */
  const assignmentScopes = new Map<string, Promise<AssignmentScope>>();
  const clientFactory: ClientFactory = options.clientFactory ?? defaultClientFactory;
  let stopping = false;

  function sharedLog(assignmentDir: string): Promise<ChatLog> {
    let log = logs.get(assignmentDir);
    if (!log) {
      log = openChatLog(assignmentDir);
      logs.set(assignmentDir, log);
    }
    return log;
  }

  /**
   * One assignment scope per assignment directory, cached like `sharedLog` and
   * for the same reason: its normalizer owns the per-scope ordinals that make
   * item ids stable, so two instances would hand out colliding ids. The cached
   * value is the PROMISE, so two concurrent callers share one replay.
   */
  function assignmentScope(assignment: ResolvedAssignment): Promise<AssignmentScope> {
    let pending = assignmentScopes.get(assignment.assignmentDir);
    if (!pending) {
      pending = (async () => {
        const log = await sharedLog(assignment.assignmentDir);
        const key = assignmentScopeKey(assignment.id);
        const scope: AssignmentScope = {
          key,
          log,
          normalizer: new ChatNormalizer({
            assignmentId: assignment.id,
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
      assignmentScopes.set(assignment.assignmentDir, pending);
    }
    return pending;
  }

  /** Keep the routed user messages to hand — `withdraw` needs `deliveredTo`. */
  function noteScopeItem(scope: AssignmentScope, patch: ItemPatch): void {
    if (patch.op !== 'upsert') return;
    if (patch.item.type === 'user.message') scope.messages.set(patch.item.messageId, patch.item);
    else if (patch.item.type === 'handoff') scope.handoffs.set(patch.item.handoffId, patch.item);
  }

  /**
   * Append a routing-level event to the assignment scope (Decision 3). No agent
   * session owns these rows, so there is no per-session flush window: each patch
   * is broadcast immediately.
   */
  async function recordAssignment(
    assignment: ResolvedAssignment,
    kind: ChatEventKind,
    payload: unknown,
    opts: { agentId: string; turnId?: string | null },
  ): Promise<ChatEvent> {
    const scope = await assignmentScope(assignment);
    const event = await scope.log.append({
      assignmentId: assignment.id,
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
        projectSlug: assignment.projectSlug,
        assignmentSlug: assignment.assignmentSlug,
        timestamp: iso(),
        payload: { assignmentId: assignment.id, patch },
      });
    }
    return event;
  }

  /** Definitions and the participant set, read together on every routing pass. */
  async function routingContext(assignment: ResolvedAssignment) {
    const { definitions } = await loadAgentDefinitions(options.syntaurHome);
    const stored = await readParticipants(assignment.assignmentDir, definitions);
    const hopBudget = stored.hopBudget ?? options.routing?.hopBudget ?? DEFAULT_HOP_BUDGET;
    return { definitions, participants: { ...stored, hopBudget } };
  }

  // --- events, items, broadcast -------------------------------------------

  async function record(
    session: Session,
    kind: ChatEventKind,
    payload: unknown,
    turnId: string | null = session.inFlight?.turnId ?? null,
  ): Promise<void> {
    const event = await session.log.append({
      assignmentId: session.assignment.id,
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
      projectSlug: session.assignment.projectSlug,
      assignmentSlug: session.assignment.assignmentSlug,
      timestamp: iso(),
      payload: { assignmentId: session.assignment.id, patch },
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
      projectSlug: session.assignment.projectSlug,
      assignmentSlug: session.assignment.assignmentSlug,
      timestamp: iso(),
      payload: {
        assignmentId: session.assignment.id,
        agentId: session.agentId,
        session: summarize(session),
      },
    });
  }

  function summarize(session: Session): ChatSessionSummary {
    return {
      assignmentId: session.assignment.id,
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
    };
  }

  function persistSession(session: Session): void {
    upsertChatSession({
      sessionKey: session.key,
      assignmentId: session.assignment.id,
      projectSlug: session.assignment.projectSlug,
      assignmentSlug: session.assignment.assignmentSlug,
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
    });
  }

  // --- session lookup ------------------------------------------------------

  async function ensureSession(
    assignment: ResolvedAssignment,
    agentId?: string | null,
  ): Promise<Session> {
    const { definitions, errors } = await loadAgentDefinitions(options.syntaurHome);
    const definition = resolveAgent(definitions, agentId ?? null);
    if (!definition) {
      throw new ChatSendError(
        agentId
          ? `No agent definition ${JSON.stringify(agentId)}${errors.length ? ` (${errors.join('; ')})` : ''}`
          : 'No agent definitions are available',
        404,
      );
    }

    const key = `${assignment.id}:${definition.id}`;
    const existing = sessions.get(key);
    if (existing) {
      existing.assignment = assignment;
      return existing;
    }
    // A construction already under way owns the repair; join it rather than
    // building (and repairing) a second session for the same key.
    const pending = constructing.get(key);
    if (pending) return pending;

    const build = buildSession(assignment, definition, key).finally(() => {
      constructing.delete(key);
    });
    constructing.set(key, build);
    return build;
  }

  async function buildSession(
    assignment: ResolvedAssignment,
    definition: AgentDefinition,
    key: string,
  ): Promise<Session> {
    const harness = HARNESSES[definition.harness as Harness];
    const log = await sharedLog(assignment.assignmentDir);
    const row = getChatSession(assignment.id, definition.id);
    const session: Session = {
      key,
      assignment,
      agentId: definition.id,
      definition,
      harness,
      profile: resolveSessionProfile(definition, harness),
      log,
      normalizer: new ChatNormalizer({
        assignmentId: assignment.id,
        agentId: definition.id,
        sessionKey: key,
      }),
      client: null,
      acpSessionId: row?.acp_session_id ?? null,
      adapterVersion: row?.adapter_version ?? null,
      cwd: row?.cwd ?? null,
      cwdTier: null,
      branch: null,
      model: null,
      mode: null,
      effort: null,
      state: row ? 'idle' : 'none',
      // A resumed ACP session already holds the standing context (spike
      // Decision 7 — `resume` replays nothing but the agent still remembers).
      standingSent: Boolean(row?.acp_session_id),
      queue: [],
      lastDeliveredSeq: row?.last_delivered_seq ?? 0,
      hopBudget: options.routing?.hopBudget ?? DEFAULT_HOP_BUDGET,
      inFlight: null,
      pendingPermissions: new Map(),
      permissionSeq: 0,
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
      driving: Promise.resolve(),
    };

    // The normalizer must pick up where the persisted log left off, so a restart
    // does not restart the per-scope ordinals and collide item ids. Every agent
    // on the assignment shares one log, so replay ONLY this session's events —
    // ingesting another agent's would consume this normalizer's ordinals and
    // re-attribute its items.
    const all = await log.readAll();
    const events = all.filter((event) => event.sessionKey === key);
    for (const event of events) session.normalizer.ingest(event);

    // Repair anything the previous process left mid-flight BEFORE the session is
    // reachable, so nothing can drive a half-repaired session (Decision 12).
    // Repair reads the whole log, not just this key: since Decision 3 a message
    // routed to this agent and a handoff aimed at it live in the ASSIGNMENT
    // scope, and neither is visible under its own key.
    await repairSession(session, events, all);

    if (stopping) {
      // `stopAll` began while this session was being built. Publishing now would
      // put it into a map the shutdown pass has already walked, leaving a
      // session nothing ever tears down (round 3). Shut it down here instead.
      await shutdownSession(session);
      return session;
    }
    sessions.set(key, session);

    // Messages recovered by the repair are sent without waiting for the human to
    // type something new — the docs promise they are "re-queued and sent in
    // order", and opening the Chat tab only calls `getSession` (round 2,
    // finding 2).
    if (session.queue.length > 0 && !session.inFlight && !stopping) void drive(session);
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
      await recordAssignment(
        session.assignment,
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
      await recordAssignment(
        session.assignment,
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
    const scopeKey = assignmentScopeKey(session.assignment.id);
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
    /**
     * Highest `perm:<n>` suffix this session has ever minted. `permissionSeq`
     * restarts at 0 on load, so without this a new request would reuse an id
     * the log already holds and collide with a still-rendered item (round 2,
     * finding 3).
     */
    let maxPermissionSeq = -1;

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
      }
    }

    /**
     * What this agent should still run, in log order. Routing is NEVER re-run
     * and no new `handoff` is written: a chain survives a crash exactly as far
     * as its already-recorded handoffs and nothing beyond them is invented.
     */
    const pending = new Map<string, { text: string; trigger: TurnTrigger }>();
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
        const { participants } = await routingContext(session.assignment);
        if (!participants.agents.includes(session.agentId)) pending.clear();
      } catch {
        // Definitions or participants unreadable — recover everything.
      }
    }

    // Continue the id sequence rather than restarting it, whether or not there
    // is anything else to repair.
    session.permissionSeq = maxPermissionSeq + 1;

    if (openTurns.size === 0 && pending.size === 0 && openPermissions.size === 0) {
      // Still close a dangling engagement even with a clean log — an engagement
      // can outlive its turn if the process died between the two writes.
      closeDanglingEngagement(session);
      return;
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
   * Materialise every session this assignment has on disk, so `withdraw`,
   * `cancel` and `answerPermission` see the rehydrated queue and permission
   * state after a restart instead of an empty in-memory map (finding 8).
   */
  async function ensureAssignmentSessions(assignment: ResolvedAssignment): Promise<Session[]> {
    const agentIds = new Set(listChatSessions(assignment.id).map((row) => row.agent_id));
    // Attached agents count even before they have a row: `withdraw`, `cancel`
    // and the SPA's initial load must all see the same set (round 1, finding
    // 12), and an agent attached in the picker has no row until it first runs.
    try {
      const { participants } = await routingContext(assignment);
      for (const agentId of participants.agents) agentIds.add(agentId);
    } catch {
      // Unreadable definitions must not hide the sessions that DO have rows.
    }
    for (const agentId of agentIds) {
      try {
        await ensureSession(assignment, agentId);
      } catch {
        // A definition that has since been deleted or broken must not stop the
        // others from being reachable.
      }
    }
    if (agentIds.size === 0) await ensureSession(assignment, null).catch(() => undefined);
    return [...sessions.values()].filter((s) => s.assignment.id === assignment.id);
  }

  /**
   * Read `workspace.*` from assignment.md and resolve the adapter's cwd.
   * Uses the chat-specific resolver that adds project-repository and home
   * fallback tiers — a chat is never refused for a missing worktree.
   */
  async function resolveCwd(session: Session): Promise<string> {
    const path = resolve(session.assignment.assignmentDir, 'assignment.md');
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
    if (session.assignment.projectSlug) {
      try {
        const projectPath = resolve(
          options.projectsDir,
          session.assignment.projectSlug,
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
      assignmentSlug: session.assignment.assignmentSlug,
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
    const resolved = resolveCommand(session.harness);
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
        ...profileEnv(session.profile),
        // Prevent the SessionStart hook from merging into ~/.syntaur/context.json
        // when the session is running from the home directory.
        ...(session.cwdTier === 'home' ? { SYNTAUR_SKIP_CONTEXT_MERGE: '1' } : {}),
      },
      onUpdate: (notification) => {
        void onUpdate(session, notification);
      },
      onPermissionRequest: (request) => onPermissionRequest(session, request),
      onExit: (info) => {
        void onExit(session, info);
      },
    });
  }

  async function ensureAdapter(session: Session): Promise<void> {
    if (session.client?.alive() && session.acpSessionId) return;

    const previousCwd = session.cwd;
    const cwd = await resolveCwd(session);
    session.cwd = cwd;

    // Home-tier mode override: default to `ask` when the definition has no pinned mode.
    if (session.cwdTier === 'home' && session.profile.mode.kind === 'inherit') {
      session.profile = { ...session.profile, mode: pin('ask') };
    }

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
      const probe = probeAuth(session.harness);
      await client.close();
      session.client = null;
      setState(session, 'error', `${(err as Error).message} — ${probe}`);
      throw new ChatSendError(
        `${session.harness.command} failed to start: ${(err as Error).message}. ${probe}`,
        503,
      );
    }
    session.adapterVersion = readAdapterVersion(init);

    const previous = session.acpSessionId;
    let resumed = false;
    let resumeResponse: acp.ResumeSessionResponse | null = null;
    if (previous) {
      try {
        resumeResponse = await client.resumeSession(previous, cwd);
        resumed = true;
      } catch (err) {
        // Decision 7's fallback: a new session, a system row saying so, and the
        // standing context again because this agent has never seen it.
        await record(session, 'session.rotated', {
          acpSessionId: previous,
          text: `Could not resume the previous agent session (${(err as Error).message}) — started a new one`,
        }, null);
        session.standingSent = false;
        session.acpSessionId = null;
      }
    }

    if (resumed) {
      // `ResumeSessionResponse` carries `modes` and `configOptions` just like
      // `session/new`, and the adapter really does send them. Without this the
      // resumed session forgot its model and the cumulative cost snapshot split
      // across two keys (`opus[1m]` and the harness-id fallback), which made the
      // engagement window delta read zero.
      if (resumeResponse) readSessionConfig(session, resumeResponse);
      await record(session, 'session.resumed', {
        acpSessionId: previous,
        harness: session.harness.id,
        adapterVersion: session.adapterVersion,
        cwd,
      }, null);
    } else {
      const meta = newSessionMeta(session.profile, session.harness, session.definition.systemPrompt);
      const created = await client.newSession({ cwd, mcpServers: meta.mcpServers, _meta: meta._meta });
      session.acpSessionId = created.sessionId;
      readSessionConfig(session, created);
      const { applied, errors } = await applyProfile(
        client,
        created.sessionId,
        session.profile,
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
      session.standingSent = false;
    }

    await registerAgentSession(session, cwd);
    setState(session, 'ready', null);

    // Announce where the session is running.
    if (session.cwdTier && session.cwdTier !== 'worktree') {
      const tierMessages: Record<string, string> = {
        repository: `Running in ${cwd} (repository fallback)`,
        project: `Running in ${cwd} (project repository) — this assignment has no worktree; create one from the assignment header`,
        home: `Running in ${cwd} — this assignment has no worktree; create one from the assignment header`,
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
        projectSlug: session.assignment.projectSlug,
        assignmentSlug: session.assignment.assignmentSlug,
        assignmentId: session.assignment.id,
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
  function readSessionConfig(
    session: Session,
    response: Pick<acp.NewSessionResponse, 'modes' | 'configOptions'>,
  ): void {
    session.mode = response.modes?.currentModeId ?? session.mode;
    for (const option of response.configOptions ?? []) {
      const value = (option as { id?: string; currentValue?: unknown }).currentValue;
      const id = (option as { id?: string }).id;
      if (typeof value !== 'string') continue;
      if (id === session.harness.configIds.model) session.model = value;
      else if (id === session.harness.configIds.effort) session.effort = value;
      else if (id === 'mode') session.mode = value;
    }
  }

  // --- adapter callbacks ---------------------------------------------------

  async function onUpdate(session: Session, notification: acp.SessionNotification): Promise<void> {
    const turn = session.inFlight;
    if (turn) {
      // Any activity resets the idle watchdog. claude's silent window at the
      // inherited xhigh effort is 25 s, so this has to be minutes, not seconds.
      armTurnIdle(session, turn);
      const update = notification.update as { sessionUpdate?: string; cost?: { amount?: number } | null };
      if (update.sessionUpdate === 'usage_update' && typeof update.cost?.amount === 'number') {
        // Cumulative for the session, not for this turn — see Decision 11.
        turn.reportedCumulativeCost = update.cost.amount;
      }
    }
    await record(session, 'acp.update', notification.update);
  }

  function onPermissionRequest(
    session: Session,
    request: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const requestId = `${session.key}:perm:${session.permissionSeq++}`;
    const title = request.toolCall?.title ?? request.toolCall?.toolCallId ?? 'a tool call';
    return new Promise<acp.RequestPermissionResponse>((resolvePermission) => {
      const timer = setTimeout(() => {
        void timeoutPermission(session, requestId, title);
      }, timeouts.permissionMs);
      timer.unref?.();
      session.pendingPermissions.set(requestId, {
        resolve: resolvePermission,
        timer,
        title,
        options: request.options ?? [],
      });
      void record(session, 'acp.permission_request', { requestId, request });
    });
  }

  async function timeoutPermission(session: Session, requestId: string, title: string): Promise<void> {
    const pending = session.pendingPermissions.get(requestId);
    if (!pending) return;
    session.pendingPermissions.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve({ outcome: { outcome: 'selected', optionId: rejectOption(pending.options) } });
    await record(session, 'acp.permission_response', { requestId, timedOut: true });
    // The Inbox has no write API; its `question` category is derived from
    // unresolved comments.md questions, so that is the door (Decision 9).
    try {
      await appendComment({
        assignmentDir: session.assignment.assignmentDir,
        assignmentRef: session.assignment.assignmentSlug,
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
      clearTimeout(pending.timer);
      pending.resolve({ outcome: { outcome: 'cancelled' } });
      session.pendingPermissions.delete(requestId);
      await record(session, 'acp.permission_response', { requestId, cancelled: true }, turn.turnId);
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
    entry: { text: string; trigger: TurnTrigger },
  ): TurnPromptTrigger {
    if (entry.trigger.kind === 'human') {
      return { author: 'human', text: entry.text, ts: new Date(now()) };
    }
    return {
      author: { agentId: entry.trigger.fromAgentId },
      text: entry.text,
      ts: new Date(now()),
      hop: { n: entry.trigger.hop, budget: session.hopBudget },
    };
  }

  /**
   * The standing context, with the roster: who this agent is and who else is in
   * the room. Sent once per adapter session (§2.4).
   */
  async function buildStanding(session: Session): Promise<ContentBlock[]> {
    const { definitions, participants } = await routingContext(session.assignment);
    const roster = participants.agents
      .map((id) => definitions.find((d) => d.id === id))
      .filter((d): d is AgentDefinition => d !== undefined);
    return buildStandingContext({
      definition: session.definition,
      harness: session.harness,
      assignmentDir: session.assignment.assignmentDir,
      context: {
        projectSlug: session.assignment.projectSlug,
        assignmentSlug: session.assignment.assignmentSlug,
        worktreePath: session.cwd,
        branch: session.branch,
        cwdTier: session.cwdTier,
        agent: session.definition,
        roster,
      },
    });
  }

  /**
   * The `<chat-history>` delta for this turn, with the trigger itself excluded —
   * it is appended as the last `<chat-event>` and must not be quoted twice.
   */
  async function buildHistory(session: Session, trigger: TurnTrigger) {
    const scope = await assignmentScope(session.assignment);
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
      items: listChatItemsSince(session.assignment.id, session.lastDeliveredSeq),
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

    const turnId = randomUUID();
    const startedAt = iso();
    const tokensAtOpen = snapshotOf(session);
    const engagement = openEngagement({
      sessionId: session.acpSessionId!,
      assignmentId: session.assignment.id,
      projectSlug: session.assignment.projectSlug,
      assignmentSlug: session.assignment.assignmentSlug,
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
    // the assignment-scope item's `deliveredTo` grows and its state moves
    // queued → partial → sent (Decision 3). The per-agent normalizer never
    // touches that row.
    if (next.trigger.kind === 'human') {
      await recordAssignment(
        session.assignment,
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
    const history = await buildHistory(session, next.trigger);
    turn.deliveredSeqCandidate = history.highestSeq;

    let blocks: ContentBlock[];
    try {
      const standing = session.standingSent ? undefined : await buildStanding(session);
      blocks = buildTurnPrompt(promptTrigger(session, next), { standing, history });
      // Sent once per adapter session (§2.4); a later turn carries only the
      // trigger and the history the session has not seen.
      session.standingSent = true;
    } catch (err) {
      blocks = buildTurnPrompt(promptTrigger(session, next), { history });
      await record(session, 'system', {
        level: 'warn',
        text: `Could not build the standing context: ${(err as Error).message}`,
      });
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
    try {
      response = await session.client!.prompt(session.acpSessionId!, blocks);
    } catch (err) {
      failure = err instanceof Error ? err : new Error(String(err));
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
    await record(
      session,
      'turn.end',
      {
        stopReason,
        endedAt: iso(),
        durationMs: Math.max(0, now() - turn.startedMs),
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

    recordUsageEvent(session);
    persistSession(session);
    flush(session);

    // A cancelled or failed turn never hops: there is no sealed reply to hand
    // on, and inventing one would restart a chain the human just stopped.
    if (!failure && stopReason !== 'cancelled') {
      try {
        await routeReply(session, turn);
      } catch (err) {
        await record(session, 'system', {
          level: 'warn',
          text: `Could not route this reply to another agent: ${(err as Error).message}`,
        }, null);
        flush(session);
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
  async function routeReply(session: Session, turn: InFlightTurn): Promise<void> {
    const { definitions, participants } = await routingContext(session.assignment);
    session.hopBudget = participants.hopBudget ?? DEFAULT_HOP_BUDGET;

    const turnItems = listChatItemsByTurn(session.assignment.id, turn.turnId);
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
      await recordAssignment(
        session.assignment,
        'route.notice',
        { level: 'warn', text: notice },
        { agentId: SYSTEM_AGENT_ID },
      );
    }

    const triggerItemId = replies[replies.length - 1]?.itemId ?? null;
    for (const hop of result.hops) {
      // Materialise the target BEFORE the `handoff` event is written. Building a
      // session runs `repairSession`, which re-enqueues every recorded handoff
      // the target never started — so writing the event first and building
      // second would have repair and this loop each enqueue the same hop, and
      // the target would run it twice.
      const target = await ensureSession(session.assignment, hop.toAgentId);
      // The id is minted BEFORE the event so the same value keys the payload,
      // the target turn's trigger and the repair pass (round 2, finding 7).
      const handoffId = randomUUID();
      await recordAssignment(
        session.assignment,
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
  }

  /**
   * Add a turn to an agent's queue, at most once per trigger. One trigger is one
   * turn: a message is delivered to a target once and a handoff is answered
   * once, whether it arrived from the router or from crash recovery.
   */
  function enqueue(session: Session, entry: { text: string; trigger: TurnTrigger }): boolean {
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
   * assignment's cost several-fold. Otherwise (codex) the priced per-turn value
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
  function recordUsageEvent(session: Session): void {
    if (session.harness.id !== 'codex' || !session.acpSessionId) return;
    const key = modelKey(session);
    const totals = session.cumulative.models[key];
    if (!totals) return;
    // codex reports no cost of its own, so an unpriced model silently books
    // every turn at $0. Say so once rather than letting the rail quietly read
    // zero (Decision 10).
    if (!session.unpricedNoticeSent && priceForModel(key, ZERO_BUCKETS) === null) {
      session.unpricedNoticeSent = true;
      void record(session, 'system', {
        level: 'info',
        text: `No price list entry for ${key}, so this chat's turns are costed at $0. Token counts are still recorded.`,
      }, null);
    }
    try {
      upsertEvent({
        sessionId: session.acpSessionId,
        model: key,
        tool: 'acp-codex',
        eventTs: iso(),
        inputTokens: totals.input,
        outputTokens: totals.output,
        cacheCreationTokens: totals.cacheCreation,
        cacheReadTokens: totals.cacheRead,
        totalTokens: totals.total,
        totalCost: totals.cost,
        // The upsert only preserves the stored slugs when the incoming ones are
        // empty, so every write carries them.
        cwd: session.cwd,
        projectSlug: session.assignment.projectSlug ?? '',
        assignmentSlug: session.assignment.assignmentSlug,
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
    await client.close();
    clearChatSessionPid(session.key);
    await record(session, 'session.idle', {}, null);
    if (session.acpSessionId) {
      await updateSessionStatus('', session.acpSessionId, 'stopped', iso()).catch(() => false);
    }
    setState(session, 'idle');
  }

  // --- public surface ------------------------------------------------------

  return {
    async send({ assignment, agentId, text }) {
      if (!text.trim()) throw new ChatSendError('Message is empty', 400);
      const { definitions, participants } = await routingContext(assignment);
      if (definitions.length === 0) throw new ChatSendError('No agent definitions are available', 404);

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

      // Refuse before anything is recorded when there is no workspace to run in
      // — the phase-2 contract, now checked once for the whole fan-out because
      // every agent on an assignment runs in the same cwd.
      const targetSessions: Session[] = [];
      for (const target of targets) targetSessions.push(await ensureSession(assignment, target));
      if (targetSessions[0]) await resolveCwd(targetSessions[0]);

      const messageId = randomUUID();
      await recordAssignment(
        assignment,
        'user.message',
        {
          messageId,
          text,
          state: 'queued',
          mentions,
          targets,
          unknown,
        },
        { agentId: HUMAN_AGENT_ID },
      );
      for (const notice of notices) {
        await recordAssignment(
          assignment,
          'route.notice',
          { level: 'warn', text: notice },
          { agentId: SYSTEM_AGENT_ID },
        );
      }
      if (targets.length === 0) {
        await recordAssignment(
          assignment,
          'route.notice',
          {
            level: 'warn',
            text: 'No agent is attached to this assignment, so nothing was started. Attach one from “Manage agents”.',
          },
          { agentId: SYSTEM_AGENT_ID },
        );
      }

      for (const session of targetSessions) {
        enqueue(session, { text, trigger: { kind: 'human', messageId } });
        void drive(session);
      }
      return { messageId };
    },

    async withdraw(assignment, messageId) {
      // A fan-out message sits in EVERY target's queue, so all of them are
      // searched — and after a restart none of them are in memory until they
      // are materialised (round 1, finding 4).
      const all = await ensureAssignmentSessions(assignment);
      const scope = await assignmentScope(assignment);
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
      await recordAssignment(
        assignment,
        'user.message',
        { messageId, text: '', state: 'withdrawn' },
        { agentId: HUMAN_AGENT_ID },
      );
      return true;
    },

    async cancel(assignment, agentId) {
      // With an id, cancel that agent; without one, cancel every agent that is
      // mid-turn — a fan-out or a hop chain can have several running at once.
      const running = (await ensureAssignmentSessions(assignment)).filter(
        (s) => s.inFlight !== null && (!agentId || s.agentId === agentId),
      );
      if (running.length === 0) return false;
      const results = await Promise.all(running.map((session) => cancelTurn(session)));
      return results.some(Boolean);
    },

    async answerPermission(assignment, requestId, optionId) {
      const session = (await ensureAssignmentSessions(assignment)).find((s) =>
        s.pendingPermissions.has(requestId),
      );
      const pending = session?.pendingPermissions.get(requestId);
      if (!session || !pending) return false;
      session.pendingPermissions.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve({ outcome: { outcome: 'selected', optionId } });
      await record(session, 'acp.permission_response', { requestId, optionId });
      flush(session);
      return true;
    },

    async getSession(assignment, agentId) {
      const session = await ensureSession(assignment, agentId ?? null);
      return summarize(session);
    },

    listAgents: () => loadAgentDefinitions(options.syntaurHome),

    async getParticipants(assignment) {
      const { definitions } = await loadAgentDefinitions(options.syntaurHome);
      return {
        participants: await readParticipants(assignment.assignmentDir, definitions),
        agents: definitions.map(toAgentSummary),
      };
    },

    async setParticipants(assignment, next) {
      const { definitions } = await loadAgentDefinitions(options.syntaurHome);
      // Materialise every session the CURRENT set knows about before the write,
      // so an agent about to be detached is reachable even if nothing has
      // touched it since the dashboard started.
      const before = await ensureAssignmentSessions(assignment);
      const previous = await readParticipants(assignment.assignmentDir, definitions);
      const participants = await writeParticipants(assignment.assignmentDir, next, definitions);
      const detached = previous.agents.filter((id) => !participants.agents.includes(id));
      for (const agentId of detached) {
        const session = before.find((s) => s.agentId === agentId);
        if (session) await detachSession(session);
      }
      const agents = definitions.map(toAgentSummary);
      options.broadcast({
        type: 'chat-participants',
        projectSlug: assignment.projectSlug,
        assignmentSlug: assignment.assignmentSlug,
        timestamp: iso(),
        payload: { assignmentId: assignment.id, participants, agents },
      });
      return { participants, agents };
    },

    items: (assignment, opts) => listChatItems(assignment.id, opts),

    async reindex(assignment) {
      // Imported here rather than at the top: the store imports the normalizer,
      // and the broker only needs the rebuild on this one path.
      const { rebuildChatIndex } = await import('./store.js');
      const result = await rebuildChatIndex(assignment.assignmentDir, assignment.id);
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
          clearTimeout(pending.timer);
          pending.resolve({ outcome: { outcome: 'cancelled' } });
          session.pendingPermissions.delete(requestId);
          await record(session, 'acp.permission_response', { requestId, cancelled: true });
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

const defaultClientFactory: ClientFactory = (input) =>
  spawnAcpClient({
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    env: input.env,
    onUpdate: input.onUpdate,
    onPermissionRequest: input.onPermissionRequest,
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
