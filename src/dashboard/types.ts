import type { TicketStatus, TransitionCommand } from '../lifecycle/types.js';

// Re-export for convenience in dashboard modules
export type { TicketStatus, TransitionCommand } from '../lifecycle/types.js';

// --- API Response Types ---

export type ProgressCounts = Record<string, number> & { total: number };

export interface NeedsAttention {
  blockedCount: number;
  failedCount: number;
  openQuestions: number;
}

export interface ProjectSummary {
  slug: string;
  title: string;
  status: string;
  statusOverride: string | null;
  archived: boolean;
  archivedAt: string | null;
  archivedReason: string | null;
  created: string;
  updated: string;
  tags: string[];
  externalIds: ExternalIdInfo[];
  progress: ProgressCounts;
  needsAttention: NeedsAttention;
}

export interface EnrichedLink {
  id: string;
  slug: string;
  projectSlug: string;
  ticketSlug: string;
  title: string;
  status: string;
  isReverse: boolean;
}

export interface TicketSummary {
  id: string;
  slug: string;
  title: string;
  status: string;
  template: string | null;
  statusLabel: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  assignee: string | null;
  depends_on: string[];
  links: string[];
  tags: string[];
  created: string;
  updated: string;
  /** Non-null when blocked; reason string from `block`. */
  blocked: string | null;
  /** Non-null when parked; reason string from `park`. */
  parked: string | null;
  /** Loader-derived from events: latest `moved` into terminal stage, else null. */
  completedAt: string | null;
  /** Loader-derived from events: ms since latest `moved` or `created`. */
  statusAge: number | null;
}

export interface TicketBoardItem extends TicketSummary {
  /** `null` for standalone tickets that live outside any project. */
  projectSlug: string | null;
  /** `null` for standalone tickets. */
  projectTitle: string | null;
  availableVerbs: TicketTransitionAction[];
}

/** One archived ticket row shown on the canonical Archive page. */
export interface ArchivedTicketItem {
  id: string;
  slug: string;
  title: string;
  status: string;
  template: string | null;
  priority: 'low' | 'medium' | 'high' | 'critical';
  /** `null` for standalone tickets. */
  projectSlug: string | null;
  /** `null` for standalone tickets. */
  projectTitle: string | null;
  /** This row's own archive flag — distinguishes individually-archived from cascade-hidden children. */
  archived: boolean;
  archivedAt: string | null;
  archivedReason: string | null;
  updated: string;
}

/** One archived project (expandable to ALL its child tickets) on the Archive page. */
export interface ArchivedProjectItem {
  slug: string;
  title: string;
  archivedAt: string | null;
  archivedReason: string | null;
  /** ALL children, each carrying its own `archived` flag for the badge. */
  tickets: ArchivedTicketItem[];
}

export interface ArchiveResponse {
  /** Archived projects, expandable to their children. */
  projects: ArchivedProjectItem[];
  /** @deprecated Ticket archiving removed in v2 — always empty. */
  tickets: ArchivedTicketItem[];
}

export interface ProjectDetail {
  slug: string;
  title: string;
  status: string;
  statusOverride: string | null;
  archived: boolean;
  archivedAt: string | null;
  archivedReason: string | null;
  created: string;
  updated: string;
  tags: string[];
  externalIds: ExternalIdInfo[];
  body: string;
  progress: ProgressCounts;
  needsAttention: NeedsAttention;
  tickets: TicketSummary[];
  dependencyGraph: string | null;
  /** Repository paths the project spans. Empty array when the project.md frontmatter omits the field. */
  repositories: string[];
}

export interface WorkspaceInfo {
  repository: string | null;
  worktree: string | null;
  branch: string | null;
  parentBranch: string | null;
}

export interface ExternalIdInfo {
  system: string;
  id: string;
  url: string | null;
}

/**
 * One session↔ticket engagement interval, projected for the dashboard's
 * "Session Activity" attribution view. A slim camelCase view of an
 * `EngagementRow` — token snapshots / close_reason are intentionally omitted.
 * `agent` is enriched from the owning session row (null if that row is gone).
 * `endedAt` null ⇒ the engagement is still open (in progress). Mirror of the
 * SPA-side `EngagementInfo` in `dashboard/src/hooks/useProjects.ts`.
 */
export interface EngagementInfo {
  id: number;
  sessionId: string;
  agent: string | null;
  /** Engagement stage (plan | implement | review | …) — the attribution source, NOT the derived ticket phase. */
  stage: string;
  startedAt: string;
  endedAt: string | null;
}

export interface TicketTemplateFileDetail {
  path: string;
  role: string;
  writer: string;
  description: string;
  state: string;
  exists: boolean;
  createOn: string;
  body: string | null;
  logEntries?: TicketLogEntryDetail[];
  entryTypes?: string[];
  planStatus?: string | null;
}

export interface TicketLogEntryDetail {
  timestamp: string;
  type: string;
  author: string | null;
  firstLine: string;
  body: string;
  keys?: Record<string, string>;
}

export interface TicketTemplateBlock {
  id: string;
  files: TicketTemplateFileDetail[];
}

export interface StageHandoffReceiptSummary {
  requestId: string;
  entryId: string;
  agentId: string;
  stage: string;
  state:
    | 'queued'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
    | 'superseded';
  turnId?: string;
  error?: string;
}

export interface StageHandoffDescriptor {
  entryId: string;
  stage: string;
  role: 'agent' | 'reviewer' | null;
  /** Template default agent for this stage (manual hand-off recipient). */
  defaultAgentId: string | null;
  startDefaultAgentId: string | null;
  /** Template auto policy on the stage entered by `start`. */
  startDefaultAuto: boolean;
  /** Effective auto for the current entry (recorded dispatchAuto || dispatchOverride). */
  auto: boolean;
  /** Configured template auto policy for this stage. */
  templateAuto: boolean;
  /** Recipient recorded on the current stage entry; automatic requests go here. */
  recordedTargetId: string | null;
  canDispatch: boolean;
  reason?: string;
  manualFallback: boolean;
  latestReceipt?: StageHandoffReceiptSummary;
}

export interface TicketDetail {
  id: string;
  /** `null` for standalone tickets that live outside any project. */
  projectSlug: string | null;
  slug: string;
  title: string;
  status: string;
  template: string | null;
  statusLabel: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  assignee: string | null;
  depends_on: string[];
  links: string[];
  reverseLinks: string[];
  enrichedLinks: EnrichedLink[];
  blocked: string | null;
  parked: string | null;
  workspace: WorkspaceInfo;
  tags: string[];
  /** Loader-derived (NOT stored). See {@link TicketSummary.completedAt}. */
  completedAt: string | null;
  /** Loader-derived (NOT stored). See {@link TicketSummary.statusAge}. */
  statusAge: number | null;
  /** Next verb hint from show model. */
  next: string | null;
  /** Stage-owned agent handoff descriptor (distinct from latest log handoff). */
  stageHandoff: StageHandoffDescriptor;
  created: string;
  updated: string;
  body: string;
  plan: { status: string; updated: string; body: string } | null;
  scratchpad: { updated: string; body: string } | null;
  referencedBy: TicketReference[];
  /** Full per-session stage-attribution history (oldest first). Empty when the session DB is not initialized (non-dashboard callers). */
  engagements: EngagementInfo[];
  availableVerbs: TicketTransitionAction[];
  templateBlock: TicketTemplateBlock;
}

/**
 * Reverse link: a ticket that mentions the current one in its Todos, comments,
 * progress, or handoff body. Populated by the dashboard when returning TicketDetail.
 */
export interface TicketReference {
  /** UUID of the source ticket. */
  sourceId: string;
  /** Slug of the source ticket (folder name or display slug). */
  sourceSlug: string;
  /** Title of the source ticket. */
  sourceTitle: string;
  /** Project slug of the source, or `null` if source is standalone. */
  sourceProjectSlug: string | null;
  /** Number of distinct mentions across the source's searched bodies. */
  mentions: number;
}

export interface TicketProgressEntry {
  timestamp: string;
  body: string;
}

export interface TicketProgress {
  updated: string;
  entryCount: number;
  entries: TicketProgressEntry[];
}

export interface TicketTransitionAction {
  command: string;
  label: string;
  description: string;
  targetStatus: string;
  disabled: boolean;
  disabledReason: string | null;
  warning: string | null;
  requiresReason: boolean;
}

/**
 * Overview segment identifier. Every row in the new segmented Overview maps
 * to exactly one of these. Backed by the Overview row reason copy in
 * `overviewCopy.ts`.
 */
export type OverviewSegmentId =
  | 'readyForReview'
  | 'readyToImplement'
  | 'readyForPlanning'
  | 'inProgress'
  | 'drafts'
  | 'blocked'
  | 'newestCreated'
  | 'stale';

export interface AttentionItem {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  /** `null` for standalone tickets. */
  projectSlug: string | null;
  /** `null` for standalone tickets. */
  projectTitle: string | null;
  ticketSlug: string;
  ticketTitle: string;
  status: string;
  reason: string;
  updated: string;
  href: string;
  stale: boolean;
  blocked: string | null;
  /** Which Overview segment this row was bucketed into. */
  segment: OverviewSegmentId;
  /** Milliseconds since the row was last updated, relative to response time. */
  agingMs: number;
  /** Current assignee from frontmatter; `null` if unclaimed. */
  assignee: string | null;
  /** Transitions available right now; powers the Advance quick action. */
  availableVerbs: TicketTransitionAction[];
}

/** Hero category — drives both copy lookup and the row reference. */
export type OverviewHeroKind =
  | 'review'
  | 'ready'
  | 'planning'
  | 'in_progress'
  | 'backlog'
  | 'blocked'
  | 'stale'
  | 'clean';

export interface OverviewHeroRecommendation {
  kind: OverviewHeroKind;
  /**
   * Copy key in `overviewCopy.ts`. For non-clean kinds the backend may emit
   * either the plural key (`'review'`) or the singular variant
   * (`'review.singular'`) — `total` carries the count.
   */
  copyKey: string;
  /** AttentionItem.id of the row this hero references; `null` when `kind === 'clean'`. */
  itemId: string | null;
  /** Pre-cap total in the chosen segment. `0` when `kind === 'clean'`. */
  total: number;
}

export interface OverviewSegmentPayload {
  items: AttentionItem[];
  /** Pre-cap total before display truncation. */
  total: number;
}

export interface OverviewStaleSegmentPayload extends OverviewSegmentPayload {
  /** Page size used by the server for this response. */
  limit: number;
  /** Page offset honored by the server for this response. */
  offset: number;
  /** True when there are more stale rows beyond `offset + items.length`. */
  hasMore: boolean;
}

export interface OverviewSegments {
  readyForReview: OverviewSegmentPayload;
  readyToImplement: OverviewSegmentPayload;
  readyForPlanning: OverviewSegmentPayload;
  inProgress: OverviewSegmentPayload;
  drafts: OverviewSegmentPayload;
  blocked: OverviewSegmentPayload;
  newestCreated: OverviewSegmentPayload;
  stale: OverviewStaleSegmentPayload;
}

export interface TicketsBoardResponse {
  generatedAt: string;
  tickets: TicketBoardItem[];
}

export interface RecentActivityItem {
  id: string;
  type: 'project' | 'ticket';
  title: string;
  updated: string;
  href: string;
  /** `null` when the activity is for a standalone ticket. */
  projectSlug: string | null;
  /** `null` when the activity is for a standalone ticket. */
  projectTitle: string | null;
  ticketSlug: string | null;
  summary: string;
}

export interface OverviewResponse {
  generatedAt: string;
  firstRun: boolean;
  stats: {
    activeProjects: number;
    inProgressTickets: number;
    blockedTickets: number;
    reviewTickets: number;
    failedTickets: number;
    staleTickets: number;
  };
  hero: OverviewHeroRecommendation;
  segments: OverviewSegments;
  recentSessions: AgentSession[];
  recentProjects: ProjectSummary[];
  recentActivity: RecentActivityItem[];
}

export interface HelpCommand {
  command: string;
  description: string;
  example: string;
}

export interface HelpSectionLink {
  label: string;
  href: string;
}

export interface HelpConcept {
  term: string;
  description: string;
}

export interface HelpStatusGuideEntry {
  status: string;
  meaning: string;
  useWhen: string;
}

export interface HelpOwnershipRule {
  label: string;
  files: string[];
  description: string;
}

export interface HelpChecklistItem {
  title: string;
  detail: string;
  command?: HelpCommand;
  href?: string;
}

export interface HelpNavigationItem {
  label: string;
  description: string;
  href: string;
}

export interface HelpResponse {
  generatedAt: string;
  whatIsSyntaur: {
    summary: string;
    bullets: string[];
  };
  coreConcepts: HelpConcept[];
  workflow: HelpChecklistItem[];
  statusGuide: HelpStatusGuideEntry[];
  ownershipRules: HelpOwnershipRule[];
  commands: HelpCommand[];
  navigation: HelpNavigationItem[];
  faq: Array<{
    question: string;
    answer: string;
  }>;
  firstProjectChecklist: HelpChecklistItem[];
  links: HelpSectionLink[];
}

// --- Playbook Types ---

export interface PlaybookSummary {
  slug: string;
  name: string;
  description: string;
  whenToUse: string;
  tags: string[];
  created: string;
  updated: string;
  enabled: boolean;
}

export interface PlaybookDetail extends PlaybookSummary {
  body: string;
}

export interface PlaybooksResponse {
  generatedAt: string;
  playbooks: PlaybookSummary[];
}

export type EditableDocumentType =
  | 'project'
  | 'ticket'
  | 'plan'
  | 'scratchpad'
  | 'playbook';

export interface EditableDocumentResponse {
  documentType: EditableDocumentType;
  title: string;
  content: string;
  projectSlug: string | null;
  ticketSlug?: string;
  /** For standalone tickets, the UUID (routes use /tickets/:id/...). */
  ticketId?: string;
  appendOnly: boolean;
}

// --- WebSocket Message Types ---

export type WsMessageType =
  | 'project-updated'
  | 'ticket-updated'
  | 'agent-sessions-updated'
  | 'playbooks-updated'
  | 'chat-item'
  | 'chat-session'
  | 'chat-participants'
  | 'chat-agents'
  | 'stage-dispatch'
  | 'connected';

export interface WsMessage {
  type: WsMessageType;
  projectSlug?: string | null;
  /** Ticket id from the `<ID>-<slug>` folder name (preferred for refetch). */
  ticketId?: string;
  /** Display slug parsed from the folder name when available. */
  ticketSlug?: string;
  timestamp: string;
  /**
   * Frame body. Every other message type is a refetch HINT — the client
   * re-reads the affected record over REST — but the chat stream would hit REST
   * ~36 times a second on codex, so `chat-item`, `chat-session` and
   * `chat-participants` carry their payload inline (Decision 3). Consumers
   * filter by `payload.ticketId`.
   */
  payload?: unknown;
}

// --- Agent Session Types ---

export type AgentSessionStatus = 'active' | 'completed' | 'stopped';




/**
 * Who hosts a tracked session's process (`sessions.hosted_by`).
 *
 * `'acp'` — and, since schema v11, nothing else — is a ticket-chat session
 * hosted by the dashboard's own ACP client. The broker owns those rows'
 * `active`/`stopped` transitions outright, which is why the stale sweep exempts
 * them (Decision 1). Every other row is `null`: a hook-registered terminal
 * session, or one predating the chat. The old PTY backends (`syntaurd`, `tmux`,
 * `claude-bg`) went with the daemon and were nulled by the v11 rebuild.
 */
export type SessionHostedBy = 'acp';

export interface AgentSession {
  projectSlug: string | null;
  ticketSlug: string | null;
  /**
   * The binding's resolved ticket frontmatter `id`, when the registering
   * caller resolved it from the slugs (M1). Threaded into the opened engagement's
   * `ticket_id` so a later stage assertion doesn't split the interval just to
   * repair the id. Null/absent when unresolved (slug-only binding).
   */
  ticketId?: string | null;
  agent: string;
  sessionId: string;
  started: string;
  ended?: string | null;
  status: AgentSessionStatus;
  path: string;
  description?: string | null;
  transcriptPath?: string | null;
  originalHeadSha?: string | null;
  updatedAt?: string | null;
  /**
   * Who hosts this session's process. `'acp'` means the dashboard's own chat
   * broker owns it, which exempts the row from the stale sweep; null is every
   * other session (a hook-registered terminal, or one predating the chat).
   */
  hostedBy?: SessionHostedBy | null;
  /**
   * Rolled-up spend for this session id, joined from `usage_events` at serve
   * time (there is no FK — usage and sessions are independent id spaces).
   * Null/absent when the collector has no rows for the session.
   */
  usage?: SessionUsageSummary | null;
  /**
   * True for synthetic rows that exist only in `usage_events` — spend ccusage
   * recorded for a session Syntaur never tracked. They carry no transcript,
   * liveness, or actions and are only emitted when the caller opts in.
   */
  usageOnly?: boolean;
  /** Short auto-generated blurb from the session transcript; null until summarized. */
  summary?: string | null;
  /** When {@link summary} was written (ISO 8601). */
  summarizedAt?: string | null;
  /** Provenance guard for `description` — see {@link DescriptionSource}. */
  descriptionSource?: DescriptionSource | null;
  /**
   * When the session was pinned (ISO 8601); null/absent when unpinned. Pinned
   * sessions lead the entire result set — the SQL ORDER BY carries it, so they
   * occupy the top of page 0. A re-pin stamps a fresh timestamp.
   */
  pinnedAt?: string | null;
  /**
   * When the session was archived (ISO 8601); null/absent when not archived.
   * Archived sessions are hidden from the default paged list and from the
   * unpaged `listAllSessions` / `listProjectSessions` / `listSessionsByTicket`.
   * Never hidden from `getSessionById`, `listSessionsNeedingSummary`, or
   * liveness sweeps.
   */
  archivedAt?: string | null;
}

/**
 * Who wrote `description`. 'human' is protected — the summarizer may only fill
 * an empty description or refresh one it wrote itself ('auto').
 */
export type DescriptionSource = 'human' | 'auto';

/** Per-session spend attached to {@link AgentSession.usage}. */
export interface SessionUsageSummary {
  totalCost: number;
  totalTokens: number;
  models: Array<{ model: string; cost: number; tokens: number }>;
}

export interface AgentSessionWithLiveness extends AgentSession {
  /**
   * `status === 'active'`. The resume/fork capability flags went with the
   * terminal profiles they were derived from (phase 4).
   */
  isLive: boolean;
}

export interface AgentSessionsResponse {
  sessions: AgentSessionWithLiveness[];
  generatedAt: string;
}

/**
 * One session's detail payload. Phase 4 removed the daemon join that used to
 * enrich it (short id, attachability, live state, the settled final screen) —
 * the chat owns its adapters directly and there is no browser terminal.
 */
export type AgentSessionDetail = AgentSessionWithLiveness;

export interface AgentSessionDetailResponse {
  session: AgentSessionDetail;
  generatedAt: string;
}
