/**
 * The normalizer — the lossless `ChatEvent` log turned into the eight §5.3
 * `ChatItem` types.
 *
 * Pure and deterministic: `ingest(event)` returns the patches that event caused
 * and mutates nothing outside the instance. Replaying a log through a fresh
 * normalizer therefore reproduces the live index exactly, which is the invariant
 * `rebuildChatIndex` rests on (Decision 2).
 *
 * Every rule here traces to the design doc or to a measured spike behaviour:
 *
 *  - **Coalescing** is by `messageId` (spike Decision 5). A chunk without one
 *    joins the immediately preceding no-id chunk of the same kind; whether that
 *    run is agent prose or an adapter notice is decided per session — once any
 *    chunk in the session has carried an id, no-id runs are notices, and the
 *    runs recorded before that are reclassified. The only instance observed is
 *    codex-acp forwarding codex's "Skill descriptions were shortened…" startup
 *    warning ahead of the first reply, which arrives BEFORE the first id'd
 *    chunk — hence the retroactive pass.
 *  - **One work card per run of tool calls** between two agent messages, with
 *    rows keyed on the TERMINAL status (claude goes `pending → completed`,
 *    codex `in_progress → completed`), `tool_call_update` merged partially by
 *    `toolCallId` (an absent field leaves the stored value alone), and a
 *    `rawOutput.formatted_output` fallback when `content` is empty (codex's
 *    parsed `search` calls carry none).
 *  - **The fold rule**: a short agent message still open when a `tool_call`
 *    arrives becomes the card's `lead` and is retracted. This one rule is most
 *    of the "feels like chat" effect (§5.3).
 *  - **`plan` replaces the whole list**; `tool_call_update` is partial (§5.10).
 *  - Mode/config/session-info/compaction updates and anything unknown become
 *    thin `system` rows. Nothing is silently dropped except
 *    `available_commands_update`, which stays on the event log for phase 3.
 */

import type {
  ContentBlock,
  PlanEntry,
  SessionUpdate,
  ToolCall,
  ToolCallContent,
  ToolCallLocation,
  ToolCallUpdate,
  ToolKind,
  Usage,
} from '@agentclientprotocol/sdk';
import type {
  AgentMessageItem,
  AgentPlanItem,
  AgentThoughtItem,
  AgentWorkItem,
  ChatEvent,
  ChatItem,
  HandoffItem,
  HandoffPayload,
  ItemPatch,
  PermissionRequestItem,
  PermissionRequestPayload,
  PermissionResponsePayload,
  SystemItem,
  SystemLevel,
  SystemPayload,
  ToolRow,
  ToolRowContent,
  TurnEndPayload,
  TurnStartPayload,
  TurnStatusItem,
  UserMessageDeliveredPayload,
  UserMessageItem,
  UserMessagePayload,
  UserMessageState,
} from './types.js';

/** A message longer than this, or one with a paragraph break, never folds. */
const FOLD_MAX_CHARS = 240;

/**
 * Out-of-band metadata that does NOT end a streaming message or a thought run.
 * `usage_update` in particular lands mid-turn on both adapters, and treating it
 * as a boundary would break the fold rule on claude, where the narration and its
 * tool call are adjacent.
 */
const SOFT_UPDATE_KINDS = new Set<string>([
  'usage_update',
  'available_commands_update',
  'session_info_update',
]);

interface OpenTurn {
  turnId: string;
  status: TurnStatusItem;
  startedAt: string;
  cancelRequested: boolean;
  plan: AgentPlanItem | null;
}

export interface NormalizerOptions {
  assignmentId: string;
  agentId: string;
  sessionKey: string;
}

export class ChatNormalizer {
  private readonly assignmentId: string;
  private readonly agentId: string;
  private readonly sessionKey: string;

  /** Per-scope monotonic ordinal; an item's id never changes once assigned. */
  private readonly ordinals = new Map<string, number>();
  /** `messageId` → the bubble it streams into (spike Decision 5). */
  private readonly messages = new Map<string, AgentMessageItem>();
  /** `messageId` → the replayed user bubble it streams into. */
  private readonly userChunks = new Map<string, UserMessageItem>();
  /** Syntaur-originated user messages, keyed by the id `DELETE` targets. */
  private readonly userMessages = new Map<string, UserMessageItem>();
  /** `toolCallId` → the work card that owns the row (updates can arrive late). */
  private readonly toolOwners = new Map<string, AgentWorkItem>();
  private readonly permissions = new Map<string, PermissionRequestItem>();

  /** Has any chunk in this session carried a `messageId`? */
  private idsSeen = false;
  /** No-id runs created while `idsSeen` was false, pending reclassification. */
  private pendingNoIdItems: ChatItem[] = [];
  private noIdRun: { kind: string; item: ChatItem } | null = null;

  private openMessage: AgentMessageItem | null = null;
  private openThought: AgentThoughtItem | null = null;
  private openWork: AgentWorkItem | null = null;
  /** The message sealed by the update currently being handled — the fold input. */
  private justSealedMessage: AgentMessageItem | null = null;

  private turns: OpenTurn[] = [];
  private replayScope: string | null = null;
  private replayCount = 0;

  constructor(options: NormalizerOptions) {
    this.assignmentId = options.assignmentId;
    this.agentId = options.agentId;
    this.sessionKey = options.sessionKey;
  }

  /** The turn a live event belongs to: the most recently started, unfinished one. */
  private get currentTurn(): OpenTurn | null {
    return this.turns.length > 0 ? this.turns[this.turns.length - 1] : null;
  }

  private scopeId(): string {
    if (this.replayScope) return this.replayScope;
    const turn = this.currentTurn;
    if (turn) return turn.turnId;
    return `session:${this.sessionKey}`;
  }

  private nextItemId(scopeId: string): string {
    const next = this.ordinals.get(scopeId) ?? 0;
    this.ordinals.set(scopeId, next + 1);
    return `${scopeId}:${next}`;
  }

  private base(event: ChatEvent, type: ChatItem['type']) {
    const scopeId = this.scopeId();
    return {
      itemId: this.nextItemId(scopeId),
      assignmentId: this.assignmentId,
      turnId: this.replayScope ? null : (this.currentTurn?.turnId ?? null),
      // The AUTHOR is the event's, not the instance's. In an agent scope the two
      // are always the same id; in the assignment scope (Decision 3) one
      // normalizer carries rows written by the human, by each handing-off agent
      // and by Syntaur itself, and each must render as its own author.
      agentId: event.agentId || this.agentId,
      type,
      ts: event.ts,
      seqFirst: event.seq,
      seqLast: event.seq,
      sealed: false,
    };
  }

  ingest(event: ChatEvent): ItemPatch[] {
    const patches: ItemPatch[] = [];
    switch (event.kind) {
      case 'acp.update':
        this.ingestUpdate(event, event.payload as SessionUpdate, patches);
        break;
      case 'user.message':
        this.ingestUserMessage(event, patches);
        break;
      case 'user.message.delivered':
        this.ingestUserMessageDelivered(event, patches);
        break;
      case 'handoff':
        this.ingestHandoff(event, patches);
        break;
      case 'route.notice': {
        const notice = event.payload as SystemPayload;
        this.system(event, notice.level ?? 'warn', notice.text, patches);
        break;
      }
      case 'turn.start':
        this.ingestTurnStart(event, patches);
        break;
      case 'turn.end':
        this.ingestTurnEnd(event, patches);
        break;
      case 'turn.cancel': {
        const turn = this.currentTurn;
        if (turn) turn.cancelRequested = true;
        this.system(event, 'info', 'Cancel requested', patches);
        break;
      }
      case 'acp.permission_request':
        this.ingestPermissionRequest(event, patches);
        break;
      case 'acp.permission_response':
        this.ingestPermissionResponse(event, patches);
        break;
      case 'session.load':
        this.replayCount += 1;
        this.replayScope = `replay:${this.replayCount}`;
        this.system(event, 'info', 'Replaying session history', patches);
        break;
      case 'session.loaded':
        this.sealStreams(event, patches);
        this.replayScope = null;
        break;
      case 'session.created':
      case 'session.resumed':
      case 'session.rotated':
      case 'session.idle':
      case 'session.exited':
        this.system(event, event.kind === 'session.exited' ? 'warn' : 'info', sessionEventText(event), patches);
        break;
      case 'system': {
        const payload = event.payload as SystemPayload;
        this.system(event, payload.level ?? 'info', payload.text, patches);
        break;
      }
      default:
        this.system(event, 'info', `Unhandled event ${String(event.kind)}`, patches);
    }
    return patches;
  }

  // --- ACP updates ---------------------------------------------------------

  private ingestUpdate(event: ChatEvent, update: SessionUpdate, patches: ItemPatch[]): void {
    const kind = update.sessionUpdate;

    // Metadata that arrives mid-stream is not a message boundary.
    if (!SOFT_UPDATE_KINDS.has(kind)) {
      if (kind !== 'agent_message_chunk') this.sealMessage(patches);
      if (kind !== 'agent_thought_chunk') this.sealThought(patches);
    }

    switch (kind) {
      case 'agent_message_chunk':
        this.ingestAgentChunk(event, update, patches);
        break;
      case 'agent_thought_chunk':
        this.ingestThoughtChunk(event, update, patches);
        break;
      case 'user_message_chunk':
        this.ingestUserChunk(event, update, patches);
        break;
      case 'tool_call':
        this.ingestToolCall(event, update as ToolCall & { sessionUpdate: 'tool_call' }, patches);
        break;
      case 'tool_call_update':
        this.ingestToolCallUpdate(
          event,
          update as ToolCallUpdate & { sessionUpdate: 'tool_call_update' },
          patches,
        );
        break;
      case 'plan':
        this.ingestPlan(event, (update as { entries: PlanEntry[] }).entries, patches);
        break;
      case 'plan_update': {
        // v2 draft shape: only the `items` variant maps onto our entry list.
        const content = (update as { content?: { type?: string; entries?: PlanEntry[] } }).content;
        if (content?.type === 'items' && Array.isArray(content.entries)) {
          this.ingestPlan(event, content.entries, patches);
        } else {
          this.system(event, 'info', 'Plan updated', patches);
        }
        break;
      }
      case 'plan_removed':
        this.ingestPlan(event, [], patches);
        break;
      case 'usage_update':
        this.ingestUsage(event, update as { used: number; size: number; cost?: { amount: number } | null }, patches);
        break;
      case 'available_commands_update':
        // Event log only — phase 3 uses it for `/command` autocomplete.
        break;
      default:
        this.system(event, 'info', updateText(update), patches);
    }

    // The fold candidate survives exactly one update: the tool_call that opens
    // the card. Anything else clears it.
    if (kind !== 'tool_call') this.justSealedMessage = null;
  }

  private ingestAgentChunk(
    event: ChatEvent,
    update: SessionUpdate & { content: ContentBlock; messageId?: string | null },
    patches: ItemPatch[],
  ): void {
    const text = blockText(update.content);
    const messageId = update.messageId ?? null;

    if (messageId) {
      if (!this.idsSeen) {
        this.idsSeen = true;
        this.reclassifyNoIdRuns(patches);
      }
      this.noIdRun = null;
      let item = this.messages.get(messageId);
      if (!item) {
        this.sealMessage(patches);
        this.sealWork(event, patches);
        item = { ...this.base(event, 'agent.message'), type: 'agent.message', messageId, text: '' };
        this.messages.set(messageId, item);
      }
      item.text += text;
      item.seqLast = event.seq;
      this.openMessage = item;
      patches.push({ op: 'upsert', item });
      return;
    }

    // No id: join the immediately preceding no-id run of the same kind.
    if (this.noIdRun && this.noIdRun.kind === 'agent_message_chunk') {
      const item = this.noIdRun.item;
      if (item.type === 'agent.message') {
        item.text += text;
        this.openMessage = item;
      } else if (item.type === 'system') {
        item.text += text;
      }
      item.seqLast = event.seq;
      patches.push({ op: 'upsert', item });
      return;
    }

    this.sealMessage(patches);
    this.sealWork(event, patches);
    let item: ChatItem;
    if (this.idsSeen) {
      // A session that has shown ids: a no-id chunk is an adapter notice.
      item = { ...this.base(event, 'system'), type: 'system', level: 'info', text };
    } else {
      const bubble: AgentMessageItem = {
        ...this.base(event, 'agent.message'),
        type: 'agent.message',
        messageId: `noid:${event.seq}`,
        text,
      };
      this.openMessage = bubble;
      this.pendingNoIdItems.push(bubble);
      item = bubble;
    }
    this.noIdRun = { kind: 'agent_message_chunk', item };
    patches.push({ op: 'upsert', item });
  }

  /**
   * The first id'd chunk of a session settles what the earlier no-id runs were:
   * adapter notices, not agent prose (spike Decision 5). Item ids are preserved,
   * so this is an in-place type change, not a new row.
   */
  private reclassifyNoIdRuns(patches: ItemPatch[]): void {
    for (const item of this.pendingNoIdItems) {
      if (item.type !== 'agent.message') continue;
      const replacement: SystemItem = {
        itemId: item.itemId,
        assignmentId: item.assignmentId,
        turnId: item.turnId,
        agentId: item.agentId,
        type: 'system',
        ts: item.ts,
        seqFirst: item.seqFirst,
        seqLast: item.seqLast,
        sealed: true,
        level: 'info',
        text: item.text,
      };
      this.messages.delete(item.messageId);
      if (this.openMessage === item) this.openMessage = null;
      if (this.noIdRun?.item === item) this.noIdRun = { kind: this.noIdRun.kind, item: replacement };
      patches.push({ op: 'upsert', item: replacement });
    }
    this.pendingNoIdItems = [];
  }

  private ingestThoughtChunk(
    event: ChatEvent,
    update: SessionUpdate & { content: ContentBlock },
    patches: ItemPatch[],
  ): void {
    this.noIdRun = null;
    if (!this.openThought) {
      this.openThought = { ...this.base(event, 'agent.thought'), type: 'agent.thought', text: '' };
    }
    this.openThought.text += blockText(update.content);
    this.openThought.seqLast = event.seq;
    patches.push({ op: 'upsert', item: this.openThought });
  }

  private ingestUserChunk(
    event: ChatEvent,
    update: SessionUpdate & { content: ContentBlock; messageId?: string | null },
    patches: ItemPatch[],
  ): void {
    this.noIdRun = null;
    const key = update.messageId ?? `noid-user:${event.seq}`;
    let item = this.userChunks.get(key);
    if (!item) {
      item = {
        ...this.base(event, 'user.message'),
        type: 'user.message',
        messageId: key,
        text: '',
        // An echo replayed by `session/load` — never a message Syntaur sent.
        state: 'replayed' as UserMessageState,
        sealed: true,
      };
      this.userChunks.set(key, item);
    }
    item.text += blockText(update.content);
    item.seqLast = event.seq;
    patches.push({ op: 'upsert', item });
  }

  private ingestToolCall(
    event: ChatEvent,
    update: ToolCall & { sessionUpdate: 'tool_call' },
    patches: ItemPatch[],
  ): void {
    this.noIdRun = null;
    const card = this.ensureWorkCard(event, patches);
    const row: ToolRow = {
      toolCallId: update.toolCallId,
      kind: update.kind ?? 'other',
      title: update.title,
      status: rowStatus(update.status),
      locations: update.locations ?? [],
      content: rowContent(update.content, update.rawOutput),
      ...(update.rawInput === undefined ? {} : { rawInput: update.rawInput }),
      ...(update.rawOutput === undefined ? {} : { rawOutput: update.rawOutput }),
    };
    card.tools.push(row);
    this.toolOwners.set(update.toolCallId, card);
    this.finishCard(card, event);
    patches.push({ op: 'upsert', item: card });
  }

  private ingestToolCallUpdate(
    event: ChatEvent,
    update: ToolCallUpdate & { sessionUpdate: 'tool_call_update' },
    patches: ItemPatch[],
  ): void {
    this.noIdRun = null;
    const owner = this.toolOwners.get(update.toolCallId);
    if (!owner) {
      // An update with no preceding `tool_call` — treat it as the call itself.
      this.ingestToolCall(
        event,
        {
          ...(update as unknown as ToolCall),
          title: update.title ?? update.toolCallId,
          sessionUpdate: 'tool_call',
        } as ToolCall & { sessionUpdate: 'tool_call' },
        patches,
      );
      return;
    }
    const row = owner.tools.find((r) => r.toolCallId === update.toolCallId);
    if (!row) return;

    // Partial merge: an absent field leaves the stored value alone (§5.10).
    if (update.title !== undefined && update.title !== null) row.title = update.title;
    if (update.kind !== undefined && update.kind !== null) row.kind = update.kind as ToolKind;
    if (update.status !== undefined && update.status !== null) row.status = rowStatus(update.status);
    if (update.locations !== undefined && update.locations !== null) {
      row.locations = update.locations as ToolCallLocation[];
    }
    if (update.rawInput !== undefined) row.rawInput = update.rawInput;
    if (update.rawOutput !== undefined) row.rawOutput = update.rawOutput;
    if (update.content !== undefined && update.content !== null) {
      row.content = rowContent(update.content as ToolCallContent[], row.rawOutput);
    } else if (row.content.length === 0 && row.rawOutput !== undefined) {
      // codex's parsed `search` calls carry no content at all; the terminal
      // block renders from `rawOutput.formatted_output` instead.
      row.content = rowContent(undefined, row.rawOutput);
    }

    owner.seqLast = event.seq;
    this.finishCard(owner, event);
    patches.push({ op: 'upsert', item: owner });
  }

  private ensureWorkCard(event: ChatEvent, patches: ItemPatch[]): AgentWorkItem {
    if (this.openWork) return this.openWork;
    const card: AgentWorkItem = {
      ...this.base(event, 'agent.work'),
      type: 'agent.work',
      tools: [],
      summary: { reads: 0, edits: 0, runs: 0, failed: 0, durationMs: 0 },
    };
    // The fold rule: a short narration still open when the first tool call of
    // the run arrives becomes the card's header line instead of its own bubble.
    const candidate = this.justSealedMessage;
    if (candidate && isFoldable(candidate.text)) {
      card.lead = candidate.text;
      // Keep the card where the narration was, so the turn reads in order.
      card.ts = candidate.ts;
      card.seqFirst = candidate.seqFirst;
      this.messages.delete(candidate.messageId);
      this.pendingNoIdItems = this.pendingNoIdItems.filter((i) => i !== candidate);
      if (this.noIdRun?.item === candidate) this.noIdRun = null;
      patches.push({ op: 'retract', itemId: candidate.itemId });
    }
    this.justSealedMessage = null;
    this.openWork = card;
    return card;
  }

  private ingestPlan(event: ChatEvent, entries: PlanEntry[], patches: ItemPatch[]): void {
    this.noIdRun = null;
    const turn = this.currentTurn;
    let item = turn?.plan ?? null;
    if (!item) {
      item = { ...this.base(event, 'agent.plan'), type: 'agent.plan', entries: [] };
      if (turn) turn.plan = item;
    }
    // Whole-list replace (§5.10) — never a merge.
    item.entries = entries;
    item.seqLast = event.seq;
    patches.push({ op: 'upsert', item });
  }

  private ingestUsage(
    event: ChatEvent,
    update: { used: number; size: number; cost?: { amount: number } | null },
    patches: ItemPatch[],
  ): void {
    const turn = this.currentTurn;
    if (!turn) return; // pre-turn adapter noise; the event log still has it
    turn.status.contextUsed = update.used;
    turn.status.contextSize = update.size;
    // `usage_update.cost` is the SESSION's CUMULATIVE cost, not this turn's —
    // the ACP schema says so ("Cumulative session cost") and both the spike
    // fixtures and a live run confirm it: fixture 07's two prompts in one
    // session report 0.146868 then 0.192106, and a cancelled turn reports
    // exactly the previous turn's figure. So it is NOT put on the status row
    // here; the broker subtracts the pre-turn value and reports the difference
    // on `turn.end`.
    turn.status.seqLast = event.seq;
    patches.push({ op: 'upsert', item: turn.status });
  }

  // --- Syntaur events ------------------------------------------------------

  private ingestUserMessage(event: ChatEvent, patches: ItemPatch[]): void {
    const payload = event.payload as UserMessagePayload;
    const existing = this.userMessages.get(payload.messageId);
    if (existing) {
      // A later event for the same message is a STATE change (the withdrawal);
      // it never rewrites the text or the routing.
      existing.state = payload.state ?? existing.state;
      existing.seqLast = event.seq;
      patches.push({ op: 'upsert', item: existing });
      return;
    }
    const item: UserMessageItem = {
      ...this.base(event, 'user.message'),
      type: 'user.message',
      messageId: payload.messageId,
      text: payload.text,
      state: payload.state ?? 'queued',
      // Routing is present only on a message Syntaur routed. A phase-2 row and a
      // bubble the adapter replayed carry none, and the absence is the record
      // that they were never routed (Decision 6).
      ...(payload.targets
        ? {
            targets: [...payload.targets],
            deliveredTo: [],
            mentions: [...(payload.mentions ?? [])],
            unknown: [...(payload.unknown ?? [])],
          }
        : {}),
      sealed: true,
    };
    this.userMessages.set(payload.messageId, item);
    patches.push({ op: 'upsert', item });
  }

  /**
   * One target's turn started. `deliveredTo` grows and the state follows it:
   * `queued` while nobody has started, `partial` once someone has, `sent` once
   * every target has (Decision 3). This is the ONLY place a user message leaves
   * `queued` — the per-agent normalizer never sees the row.
   */
  private ingestUserMessageDelivered(event: ChatEvent, patches: ItemPatch[]): void {
    const payload = event.payload as UserMessageDeliveredPayload;
    const item = this.userMessages.get(payload.messageId);
    if (!item) return;
    const deliveredTo = item.deliveredTo ?? [];
    if (!deliveredTo.includes(payload.agentId)) deliveredTo.push(payload.agentId);
    item.deliveredTo = deliveredTo;
    const targets = item.targets ?? [];
    // A withdrawal is terminal: a target that starts anyway (it cannot, but the
    // log is the source of truth) must not resurrect the bubble.
    if (item.state !== 'withdrawn') {
      item.state = deliveredTo.length >= targets.length ? 'sent' : 'partial';
    }
    item.seqLast = event.seq;
    patches.push({ op: 'upsert', item });
  }

  /** One agent handing the conversation to another (§5.3's `handoff` row). */
  private ingestHandoff(event: ChatEvent, patches: ItemPatch[]): void {
    const payload = event.payload as HandoffPayload;
    const item: HandoffItem = {
      ...this.base(event, 'handoff'),
      type: 'handoff',
      handoffId: payload.handoffId,
      fromAgentId: payload.fromAgentId,
      toAgentId: payload.toAgentId,
      triggerItemId: payload.triggerItemId ?? null,
      hop: payload.hop,
      budget: payload.budget,
      sealed: true,
    };
    patches.push({ op: 'upsert', item });
  }

  private ingestTurnStart(event: ChatEvent, patches: ItemPatch[]): void {
    const payload = (event.payload ?? {}) as Partial<TurnStartPayload>;
    const turnId = event.turnId ?? `turn:${event.seq}`;
    const scopeId = turnId;
    const status: TurnStatusItem = {
      itemId: `${scopeId}:${this.ordinals.get(scopeId) ?? 0}`,
      assignmentId: this.assignmentId,
      turnId,
      agentId: event.agentId || this.agentId,
      type: 'turn.status',
      ts: event.ts,
      seqFirst: event.seq,
      seqLast: event.seq,
      sealed: false,
      state: 'running',
      startedAt: payload.startedAt ?? event.ts,
      // Set only when the event has one, so a phase-2 row stays exactly as it
      // was — including in the 46 golden fixture snapshots.
      ...(payload.trigger ? { trigger: payload.trigger } : {}),
    };
    this.ordinals.set(scopeId, (this.ordinals.get(scopeId) ?? 0) + 1);
    this.turns.push({ turnId, status, startedAt: status.startedAt, cancelRequested: false, plan: null });

    // A user message's delivery state lives ONLY in the assignment scope, which
    // no agent normalizer ever sees (Decision 3). `user.message.delivered`
    // maintains it; nothing is flipped from here.
    patches.push({ op: 'upsert', item: status });
  }

  private ingestTurnEnd(event: ChatEvent, patches: ItemPatch[]): void {
    const payload = (event.payload ?? {}) as Partial<TurnEndPayload>;
    const index = event.turnId
      ? this.turns.findIndex((t) => t.turnId === event.turnId)
      : this.turns.length - 1;
    if (index < 0) return;
    const turn = this.turns[index];

    this.sealStreams(event, patches);
    if (turn.plan) {
      turn.plan.sealed = true;
      patches.push({ op: 'upsert', item: turn.plan });
    }

    const status = turn.status;
    status.state = 'ended';
    status.sealed = true;
    status.endedAt = payload.endedAt ?? event.ts;
    status.stopReason =
      payload.stopReason ?? (turn.cancelRequested ? 'cancelled' : undefined);
    status.durationMs =
      payload.durationMs ??
      Math.max(0, Date.parse(status.endedAt) - Date.parse(status.startedAt) || 0);
    if (payload.usage) status.usage = payload.usage as Usage;
    // The turn's OWN cost, computed by the broker as the delta between the
    // session's cumulative cost before and after the turn (Decision 11).
    if (typeof payload.cost === 'number') status.cost = payload.cost;
    status.seqLast = event.seq;
    patches.push({ op: 'upsert', item: status });

    this.turns.splice(index, 1);
  }

  private ingestPermissionRequest(event: ChatEvent, patches: ItemPatch[]): void {
    const payload = event.payload as PermissionRequestPayload;
    const item: PermissionRequestItem = {
      ...this.base(event, 'permission.request'),
      type: 'permission.request',
      requestId: payload.requestId,
      toolCall: {
        toolCallId: payload.request.toolCall?.toolCallId,
        title: payload.request.toolCall?.title ?? undefined,
        kind: payload.request.toolCall?.kind ?? null,
      },
      options: payload.request.options ?? [],
    };
    this.permissions.set(payload.requestId, item);
    patches.push({ op: 'upsert', item });
  }

  private ingestPermissionResponse(event: ChatEvent, patches: ItemPatch[]): void {
    const payload = event.payload as PermissionResponsePayload;
    const item = this.permissions.get(payload.requestId);
    if (!item) return;
    if (payload.optionId) item.answer = payload.optionId;
    if (payload.cancelled) item.cancelled = true;
    if (payload.timedOut) item.timedOut = true;
    item.sealed = true;
    item.seqLast = event.seq;
    patches.push({ op: 'upsert', item });
  }

  private system(event: ChatEvent, level: SystemLevel, text: string, patches: ItemPatch[]): void {
    if (!text) return;
    const item: SystemItem = {
      ...this.base(event, 'system'),
      type: 'system',
      level,
      text,
      sealed: true,
    };
    patches.push({ op: 'upsert', item });
  }

  // --- sealing -------------------------------------------------------------

  private sealMessage(patches: ItemPatch[]): void {
    const item = this.openMessage;
    this.openMessage = null;
    if (!item || item.sealed) {
      this.justSealedMessage = null;
      return;
    }
    item.sealed = true;
    this.justSealedMessage = item;
    patches.push({ op: 'upsert', item });
  }

  private sealThought(patches: ItemPatch[]): void {
    const item = this.openThought;
    this.openThought = null;
    if (!item || item.sealed) return;
    item.sealed = true;
    patches.push({ op: 'upsert', item });
  }

  private sealWork(event: ChatEvent, patches: ItemPatch[]): void {
    const card = this.openWork;
    this.openWork = null;
    if (!card || card.sealed) return;
    card.sealed = true;
    this.finishCard(card, event);
    patches.push({ op: 'upsert', item: card });
  }

  /** Everything still streaming stops streaming (turn end, replay end, shutdown). */
  private sealStreams(event: ChatEvent, patches: ItemPatch[]): void {
    this.sealMessage(patches);
    this.justSealedMessage = null;
    this.sealThought(patches);
    this.sealWork(event, patches);
    this.noIdRun = null;
  }

  private finishCard(card: AgentWorkItem, event: ChatEvent): void {
    let reads = 0;
    let edits = 0;
    let runs = 0;
    let failed = 0;
    for (const row of card.tools) {
      if (row.kind === 'read' || row.kind === 'search' || row.kind === 'fetch') reads += 1;
      else if (row.kind === 'edit' || row.kind === 'delete' || row.kind === 'move') edits += 1;
      else if (row.kind === 'execute') runs += 1;
      if (row.status === 'failed') failed += 1;
    }
    const started = Date.parse(card.ts);
    const now = Date.parse(event.ts);
    card.summary = {
      reads,
      edits,
      runs,
      failed,
      durationMs: Number.isFinite(started) && Number.isFinite(now) ? Math.max(0, now - started) : 0,
    };
  }
}

// --- pure helpers ----------------------------------------------------------

/** A short single-paragraph narration is what folds into a work card. */
export function isFoldable(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= FOLD_MAX_CHARS && !/\n\s*\n/.test(trimmed);
}

/** Key on the TERMINAL status: claude never emits `in_progress`, codex never `pending`. */
function rowStatus(status: string | null | undefined): ToolRow['status'] {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  return 'running';
}

export function blockText(block: ContentBlock | undefined | null): string {
  if (!block) return '';
  switch (block.type) {
    case 'text':
      return block.text;
    case 'resource':
      return 'text' in block.resource ? block.resource.text : `[resource ${block.resource.uri}]`;
    case 'resource_link':
      return `[${block.name ?? block.uri}]`;
    case 'image':
      return '[image]';
    case 'audio':
      return '[audio]';
    default:
      return '';
  }
}

/**
 * Flatten ACP tool content into rows the UI can render, falling back to
 * `rawOutput` when the adapter sent none (codex's parsed `search` calls).
 */
function rowContent(
  content: ToolCallContent[] | undefined,
  rawOutput: unknown,
): ToolRowContent[] {
  const out: ToolRowContent[] = [];
  for (const block of content ?? []) {
    switch (block.type) {
      case 'content':
        out.push({ type: 'text', text: blockText(block.content) });
        break;
      case 'diff':
        out.push({
          type: 'diff',
          path: block.path,
          oldText: block.oldText ?? null,
          newText: block.newText,
        });
        break;
      case 'terminal':
        out.push({ type: 'terminal', terminalId: block.terminalId });
        break;
      default:
        out.push({ type: 'other', text: JSON.stringify(block) });
    }
  }
  if (out.length > 0) return out;

  const fallback = rawOutputText(rawOutput);
  return fallback ? [{ type: 'text', text: fallback }] : [];
}

/** codex puts the command's output under `rawOutput.formatted_output`. */
export function rawOutputText(rawOutput: unknown): string | null {
  if (rawOutput === undefined || rawOutput === null) return null;
  if (typeof rawOutput === 'string') return rawOutput;
  if (typeof rawOutput === 'object') {
    const formatted = (rawOutput as { formatted_output?: unknown }).formatted_output;
    if (typeof formatted === 'string') return formatted;
    try {
      return JSON.stringify(rawOutput);
    } catch {
      return null;
    }
  }
  return String(rawOutput);
}

/** One readable line for the update kinds that become `system` rows. */
function updateText(update: SessionUpdate): string {
  switch (update.sessionUpdate) {
    case 'current_mode_update':
      return `Mode → ${(update as { currentModeId?: string }).currentModeId ?? 'unknown'}`;
    case 'config_option_update': {
      const u = update as { configId?: string; value?: unknown };
      return `Config ${u.configId ?? '?'} → ${JSON.stringify(u.value ?? null)}`;
    }
    case 'session_info_update': {
      const u = update as { title?: string | null };
      return u.title ? `Session title: ${u.title}` : 'Session info updated';
    }
    case 'compaction_update':
      return `Compacting context (${(update as { status?: string }).status ?? 'in_progress'})`;
    case 'compaction_summary_chunk':
      return `Compaction summary: ${blockText((update as { content?: ContentBlock }).content)}`;
    default:
      return `Unhandled update: ${update.sessionUpdate}`;
  }
}

function sessionEventText(event: ChatEvent): string {
  const payload = (event.payload ?? {}) as { acpSessionId?: string; text?: string; reason?: string };
  switch (event.kind) {
    case 'session.created':
      return `Agent session started (${payload.acpSessionId ?? 'unknown'})`;
    case 'session.resumed':
      return `Agent session resumed (${payload.acpSessionId ?? 'unknown'})`;
    case 'session.rotated':
      return payload.text ?? 'Could not resume the previous agent session — started a new one';
    case 'session.idle':
      return 'Agent session torn down after being idle';
    case 'session.exited':
      return payload.text ?? 'The agent adapter exited';
    default:
      return '';
  }
}
