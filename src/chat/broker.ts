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
 *    closes. Both adapters return per-turn token buckets on `PromptResponse.usage`
 *    and claude reports a per-turn `cost.amount` on the turn's last
 *    `usage_update`, so the broker keeps one cumulative snapshot per session and
 *    every turn is a priced window.
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
import { resolveWorkspaceCwd } from '../launch/cwd.js';
import { appendComment } from '../lifecycle/comment-append.js';
import { appendSession, updateSessionStatus } from '../dashboard/agent-sessions.js';
import {
  closeEngagementById,
  closeOpenEngagement,
  openEngagement,
} from '../db/engagement-db.js';
import type { ModelTokens, TokenSnapshot } from '../db/engagement-tokens.js';
import { upsertEvent } from '../db/usage-db.js';
import { priceForModel } from '../usage/pricing.js';
import {
  applyChatPatch,
  clearChatSessionPid,
  getChatSession,
  listChatItems,
  upsertChatSession,
} from '../db/chat-db.js';
import { adapterVersion as readAdapterVersion, spawnAcpClient, type AcpClient } from './acp-client.js';
import { loadAgentDefinitions, resolveAgent } from './agents.js';
import { HARNESSES, probeAuth, resolveCommand } from './harnesses.js';
import { ChatNormalizer } from './normalizer.js';
import { applyProfile, newSessionMeta, profileEnv, resolveSessionProfile, serializeProfile } from './profile.js';
import { buildStandingContext, buildTurnPrompt } from './prompt-framing.js';
import { openChatLog, type ChatLog } from './store.js';
import type {
  AgentDefinition,
  ChatEventKind,
  ChatItem,
  ChatSessionState,
  ChatSessionSummary,
  ContentBlock,
  Harness,
  HarnessSpec,
  ItemPatch,
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
    type: 'chat-item' | 'chat-session';
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
  items(assignment: ResolvedAssignment, opts: { beforeSeq?: number; limit?: number }): ChatItem[];
  reindex(assignment: ResolvedAssignment): Promise<{ events: number; items: number }>;
  stopAll(): Promise<void>;
}

// --- internals -------------------------------------------------------------

interface InFlightTurn {
  turnId: string;
  messageId: string;
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
  branch: string | null;
  model: string | null;
  mode: string | null;
  effort: string | null;
  state: ChatSessionState;
  standingSent: boolean;
  queue: Array<{ messageId: string; text: string }>;
  inFlight: InFlightTurn | null;
  pendingPermissions: Map<string, PendingPermission>;
  permissionSeq: number;
  cumulative: TokenSnapshot;
  lastTurnAt: string | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  pendingPatches: Map<string, ItemPatch>;
  error: string | null;
  /** Serialises `drive` so two sends cannot both spawn an adapter. */
  driving: Promise<void>;
}

const EMPTY_TOKENS: ModelTokens = {
  input: 0,
  output: 0,
  cacheCreation: 0,
  cacheRead: 0,
  total: 0,
  cost: 0,
};

export function createChatBroker(options: CreateChatBrokerOptions): ChatBroker {
  const timeouts: BrokerTimeouts = { ...DEFAULT_TIMEOUTS, ...(options.timeouts ?? {}) };
  const now = () => (options.clock ? options.clock.now() : Date.now());
  const iso = () => new Date(now()).toISOString();
  const sessions = new Map<string, Session>();
  const clientFactory: ClientFactory = options.clientFactory ?? defaultClientFactory;
  let stopping = false;

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
      queued: session.queue.map((q) => ({ messageId: q.messageId, text: q.text })),
      error: session.error,
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

    const harness = HARNESSES[definition.harness as Harness];
    const log = await openChatLog(assignment.assignmentDir);
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
      branch: null,
      model: null,
      mode: null,
      effort: null,
      state: row ? 'idle' : 'none',
      // A resumed ACP session already holds the standing context (spike
      // Decision 7 — `resume` replays nothing but the agent still remembers).
      standingSent: Boolean(row?.acp_session_id),
      queue: [],
      inFlight: null,
      pendingPermissions: new Map(),
      permissionSeq: 0,
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
    // does not restart the per-scope ordinals and collide item ids.
    const events = await log.readAll();
    for (const event of events) session.normalizer.ingest(event);

    sessions.set(key, session);
    return session;
  }

  /** Read `workspace.*` from assignment.md and resolve the adapter's cwd. */
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
    const result = resolveWorkspaceCwd({
      worktreePath,
      repository,
      branch,
      assignmentSlug: session.assignment.assignmentSlug,
    });
    if (!result.cwd) {
      throw new ChatSendError(
        result.invalidReason ??
          `No workspace for ${session.assignment.assignmentSlug}: set workspace.worktreePath or workspace.repository in assignment.md`,
      );
    }
    session.branch = branch;
    return result.cwd;
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
      harness: session.harness,
      command: resolved.path,
      args: [...session.harness.args],
      cwd,
      env: profileEnv(session.profile),
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

    const cwd = await resolveCwd(session);
    session.cwd = cwd;
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
        pid: session.client?.pid ?? null,
        pidStartedAt: null,
        originalHeadSha: null,
        hostedBy: 'acp',
      },
      // The row may be `stopped` from an idle teardown or a dashboard restart;
      // the broker owns its lifecycle, so it revives it itself.
      { reviveStopped: true },
    );
    closeOpenEngagement(session.acpSessionId, { closeReason: 'chat-registered', endedAt: iso() });
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
    session.driving = session.driving.then(() => driveOnce(session)).catch(() => {});
    return session.driving;
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
      return;
    }

    if (session.queue[0] !== next) return; // withdrawn while the adapter came up
    session.queue.shift();

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
      messageId: next.messageId,
      startedAt,
      startedMs: now(),
      engagementId: engagement.id,
      engagementStartedAt: engagement.started_at,
      reportedCumulativeCost: null,
      costAtOpen: session.cumulative.models[modelKey(session)]?.cost ?? 0,
      idleTimer: null,
      maxTimer: null,
      cancelled: false,
    };
    session.inFlight = turn;
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }

    await record(session, 'turn.start', { messageId: next.messageId, startedAt }, turnId);
    setState(session, 'running');

    let blocks: ContentBlock[];
    try {
      const standing = session.standingSent
        ? undefined
        : await buildStandingContext({
            definition: session.definition,
            harness: session.harness,
            assignmentDir: session.assignment.assignmentDir,
            context: {
              projectSlug: session.assignment.projectSlug,
              assignmentSlug: session.assignment.assignmentSlug,
              worktreePath: session.cwd,
              branch: session.branch,
            },
          });
      blocks = buildTurnPrompt(next.text, { standing, now: new Date(now()) });
      // Sent once per adapter session (§2.4); a later turn carries only the
      // user's message.
      session.standingSent = true;
    } catch (err) {
      blocks = buildTurnPrompt(next.text, { now: new Date(now()) });
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

    await finishTurn(session, turn, response, failure);
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

    recordUsageEvent(session);
    persistSession(session);
    flush(session);
    if (session.client?.alive()) setState(session, 'ready');
    armSessionIdle(session);
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
      const session = await ensureSession(assignment, agentId);
      // Refuse before anything is created when there is no workspace to run in.
      await resolveCwd(session);

      const messageId = randomUUID();
      session.queue.push({ messageId, text });
      await record(session, 'user.message', { messageId, text, state: 'queued' }, null);
      flush(session);
      emitSession(session);
      void drive(session);
      return { messageId };
    },

    async withdraw(assignment, messageId) {
      // Search every live session for the assignment rather than assuming the
      // default agent — the message may have been addressed to another one.
      const session = [...sessions.values()].find(
        (s) => s.assignment.id === assignment.id && s.queue.some((q) => q.messageId === messageId),
      );
      if (!session) return false;
      const at = session.queue.findIndex((q) => q.messageId === messageId);
      session.queue.splice(at, 1);
      await record(session, 'user.message', { messageId, text: '', state: 'withdrawn' }, null);
      flush(session);
      emitSession(session);
      return true;
    },

    async cancel(assignment, agentId) {
      // Cancel the turn that is actually running, whichever agent owns it.
      const running = [...sessions.values()].find(
        (s) => s.assignment.id === assignment.id && s.inFlight !== null && (!agentId || s.agentId === agentId),
      );
      if (!running) return false;
      return cancelTurn(running);
    },

    async answerPermission(assignment, requestId, optionId) {
      const session = [...sessions.values()].find(
        (s) => s.assignment.id === assignment.id && s.pendingPermissions.has(requestId),
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
