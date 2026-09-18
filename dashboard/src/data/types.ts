/**
 * Response types for the dashboard's finite HTTP resources. The dashboard is a
 * separate TS project and cannot import backend `src/` types, so these mirror
 * `src/dashboard/types.ts` (and friends) — keep them in sync. Moved here from
 * `hooks/useProjects.ts` (SV-12) so data, hooks and components share one
 * type module; `useProjects` re-exports them for existing importers.
 */
import type { AgentSession } from '../types';

export type {
  AgentSession,
  AgentSessionDetailResponse,
  AgentSessionsResponse,
  PlaybookDetail,
  PlaybookSummary,
  PlaybooksResponse,
} from '../types';

/** Where a ticket's lifetime cost came from (mirrors backend `TicketCostSource`). */
export type TicketCostSource = 'engagement' | 'usage' | 'none';

/**
 * Read-time lifetime ticket totals (mirrors backend `TicketMetrics`).
 * - `costUsd` null ⇔ `costSource === 'none'`: no recorded spend — unknown, not $0.
 * - `sessionCount` null: the session database is unavailable (unknown); 0 is a
 *   real, queried-empty count.
 * - `partial`: engagement-window cost that excludes open/unpriceable/negative
 *   windows, so the true spend may be higher.
 */
export interface TicketMetrics {
  costUsd: number | null;
  sessionCount: number | null;
  costSource: TicketCostSource;
  partial: boolean;
}

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
  blocked: string | null;
  parked: string | null;
  created: string;
  updated: string;
  completedAt: string | null;
  statusAge: number | null;
  /** Read-time lifetime cost + distinct session count (SV-12). Absent from
   * payloads produced before SV-12 — render as unknown, never as zero. */
  metrics?: TicketMetrics;
}

export interface TicketBoardItem extends TicketSummary {
  projectSlug: string | null;
  projectTitle: string | null;
  availableVerbs: TicketTransitionAction[];
}

export interface ArchivedTicketItem {
  id: string;
  slug: string;
  title: string;
  status: string;
  template: string | null;
  priority: 'low' | 'medium' | 'high' | 'critical';
  projectSlug: string | null;
  projectTitle: string | null;
  /** This row's own archive flag — distinguishes individually-archived from cascade-hidden children. */
  archived: boolean;
  archivedAt: string | null;
  archivedReason: string | null;
  updated: string;
}

export interface ArchivedProjectItem {
  slug: string;
  title: string;
  archivedAt: string | null;
  archivedReason: string | null;
  tickets: ArchivedTicketItem[];
}

export interface ArchiveResponse {
  projects: ArchivedProjectItem[];
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
 * One session↔ticket engagement interval for the "Session Activity"
 * attribution view. Slim camelCase mirror of the server `EngagementInfo`
 * (`src/dashboard/types.ts`). `agent` null ⇒ owning session row gone;
 * `endedAt` null ⇒ engagement still open (in progress).
 */
export interface EngagementInfo {
  id: number;
  sessionId: string;
  agent: string | null;
  /** Engagement stage (plan | implement | review | …) — attribution source, NOT the derived ticket phase. */
  stage: string;
  startedAt: string;
  endedAt: string | null;
}

export interface TicketLogEntryDetail {
  timestamp: string;
  type: string;
  author: string | null;
  firstLine: string;
  body: string;
  keys?: Record<string, string>;
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
  projectSlug: string | null;
  slug: string;
  title: string;
  status: string;
  template: string | null;
  statusLabel: string;
  priority: TicketSummary['priority'];
  assignee: string | null;
  depends_on: string[];
  links: string[];
  reverseLinks: string[];
  enrichedLinks: EnrichedLink[];
  blocked: string | null;
  parked: string | null;
  workspace: WorkspaceInfo;
  tags: string[];
  completedAt: string | null;
  statusAge: number | null;
  next: string | null;
  stageHandoff: StageHandoffDescriptor;
  created: string;
  updated: string;
  body: string;
  plan: { status: string; updated: string; body: string } | null;
  scratchpad: { updated: string; body: string } | null;
  referencedBy: TicketReference[];
  engagements: EngagementInfo[];
  availableVerbs: TicketTransitionAction[];
  templateBlock: TicketTemplateBlock;
  /** See {@link TicketSummary.metrics}. */
  metrics?: TicketMetrics;
}

export interface TicketReference {
  sourceId: string;
  sourceSlug: string;
  sourceTitle: string;
  sourceProjectSlug: string | null;
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
  projectSlug: string | null;
  projectTitle: string | null;
  ticketSlug: string;
  ticketTitle: string;
  status: string;
  reason: string;
  updated: string;
  href: string;
  stale: boolean;
  blocked: string | null;
  segment: OverviewSegmentId;
  agingMs: number;
  assignee: string | null;
  availableVerbs: TicketTransitionAction[];
}

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
  copyKey: string;
  itemId: string | null;
  total: number;
}

export interface OverviewSegmentPayload {
  items: AttentionItem[];
  total: number;
}

export interface OverviewStaleSegmentPayload extends OverviewSegmentPayload {
  limit: number;
  offset: number;
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
  projectSlug: string;
  projectTitle: string;
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

export interface HelpResponse {
  generatedAt: string;
  whatIsSyntaur: {
    summary: string;
    bullets: string[];
  };
  coreConcepts: Array<{
    term: string;
    description: string;
  }>;
  workflow: Array<{
    title: string;
    detail: string;
    command?: HelpCommand;
    href?: string;
  }>;
  statusGuide: Array<{
    status: string;
    meaning: string;
    useWhen: string;
  }>;
  ownershipRules: Array<{
    label: string;
    files: string[];
    description: string;
  }>;
  commands: HelpCommand[];
  navigation: Array<{
    label: string;
    description: string;
    href: string;
  }>;
  faq: Array<{
    question: string;
    answer: string;
  }>;
  firstProjectChecklist: Array<{
    title: string;
    detail: string;
    command?: HelpCommand;
    href?: string;
  }>;
  links: Array<{
    label: string;
    href: string;
  }>;
}

export type EditableDocumentType =
  | 'project'
  | 'ticket'
  | 'plan'
  | 'scratchpad'
  | 'handoff'
  | 'decision-record'
  | 'playbook';

export interface EditableDocumentResponse {
  documentType: EditableDocumentType;
  title: string;
  content: string;
  projectSlug: string;
  ticketSlug?: string;
  appendOnly: boolean;
}

export interface TicketUsageSummary {
  totalTokens: number;
  /**
   * Window/filter-scoped cost with the card's precedence (priced engagement
   * windows, else attributed usage_events). `0` with `costSource: 'none'`
   * means unknown, not free.
   */
  totalCost: number;
  lastEventDay: string | null;
  byModel: { model: string; totalTokens: number; totalCost: number }[];
  pricedWindowCount?: number;
  uncomputableWindowCount?: number;
  negativeDeltaCount?: number;
  costSource?: TicketCostSource;
  /** Lifetime, unfiltered totals — the same values as the board card and header. */
  lifetime?: TicketMetrics;
}

export interface TicketUsageResponse {
  summary: TicketUsageSummary;
  // `daily` / `events` are returned for backward compat but unused by the panel.
  daily?: unknown[];
  events?: unknown[];
}

export interface UsageDailyRow {
  day: string;
  tool: string;
  model: string;
  project_slug: string;
  ticket_id: string;
  total_tokens: number;
  total_cost: number;
}

export interface UsageSummaryRow {
  projectSlug: string;
  ticketSlug: string;
  totalTokens: number;
  totalCost: number;
  lastEventDay: string;
  pricedWindowCount?: number;
  uncomputableWindowCount?: number;
  negativeDeltaCount?: number;
  /** Per-ticket project rollups (`window-first`): which ledger `totalCost` came from. */
  costSource?: TicketCostSource;
}

/**
 * What a usage rollup's cost column sums (mirrors backend `UsageCostBasis`):
 * - `usage-daily`: the windowed daily sum (Sessions usage panel) — can differ
 *   from card/header lifetime totals, which are engagement-window-first.
 * - `window-first`: per-ticket engagement-window cost when priced, else the
 *   windowed daily sum (per-row `costSource` says which).
 */
export type UsageCostBasis = 'usage-daily' | 'window-first';

export interface WorkspaceUsageResponse {
  daily: UsageDailyRow[];
  summary: UsageSummaryRow[];
  costBasis?: UsageCostBasis;
}

export interface UsageFacets {
  models: string[];
  tools: string[];
}

/**
 * One ranked content-search hit returned by `GET /api/search` (`{ hits: [...] }`).
 *
 * MIRRORS the backend `SearchHit` in `src/search/types.ts`. The dashboard is a
 * separate TS project and cannot import backend types, so this is a local copy —
 * keep it in sync. `route` is the UNPREFIXED app path; the palette mapper
 * `snippet` is NEUTRAL text and `matches` are snippet-local char offsets;
 * the renderer escapes the text and wraps the ranges in `<mark>` (HTML-safe).
 */
export interface ContentMatchRange {
  start: number;
  end: number;
}

export interface ContentHit {
  path: string;
  projectSlug: string | null;
  ticketSlug: string | null;
  ticketId: string | null;
  standalone: boolean;
  fileKind:
    | 'ticket'
    | 'plan'
    | 'progress'
    | 'comments'
    | 'handoff'
    | 'decision-record'
    | 'scratchpad';
  title: string;
  score: number;
  snippet: string;
  matches: ContentMatchRange[];
  line: number;
  section?: string;
  /** Precomputed UNPREFIXED app route (see backend `routeForHit`). */
  route: string;
}

/**
 * One audit-timeline event for a ticket. Local to the SPA — the dashboard
 * is a separate TS project and cannot import backend `src/` types. Mirrors the
 * `EventRow` shape from `src/db/events-db.ts` with `details` already parsed from
 * its stored JSON string into an object (or null).
 */
export interface ActivityEvent {
  event_id: string;
  ticket_id: string;
  /** UTC ISO 8601, newest-first. */
  at: string;
  actor: string;
  type: string;
  details: Record<string, unknown> | null;
  source_key: string | null;
}
