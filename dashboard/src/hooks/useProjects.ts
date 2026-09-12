import { useState, useEffect, useCallback, useRef } from 'react';
import { useWebSocket } from './useWebSocket';
import type { WsMessage } from './useWebSocket';
import type { AgentSessionsResponse, AgentSessionDetailResponse, AgentSession, PlaybooksResponse, PlaybookDetail } from '../types';
import { buildUsageApiQuery, type UsageWidgetFilters } from '@shared/usage-filters';
import type { SessionSort } from '@shared/session-sort';
import type { SessionAttribution } from '@shared/session-attribution';
import type { ArchivedFilter } from '@shared/session-archived';

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
  type: string | null;
  /** Explicit `workflow:` override (null → resolved via binding). */
  workflow: string | null;
  /** The workflow id this ticket resolves to. */
  resolvedWorkflow: string;
  /** Human label of the resolved workflow. */
  workflowLabel: string;
  /** Display label of the current status WITHIN the resolved workflow. */
  statusLabel: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  assignee: string | null;
  dependsOn: string[];
  links: string[];
  tags: string[];
  externalIds: ExternalIdInfo[];
  created: string;
  updated: string;
  archived: boolean;
  archivedAt: string | null;
  archivedReason: string | null;
  /** Loader-derived: timestamp of terminal transition, null otherwise. */
  completedAt: string | null;
  /** Loader-derived: ms in current headline status; null when no history. */
  statusAge: number | null;
  /** Loader-derived: ms since last phase change; null when never recorded. */
  phaseAge: number | null;
  /** Cached phase dimension (null pre-migration). */
  phase: string | null;
  /** Cached disposition dimension (active|blocked|parked; null pre-migration). */
  disposition: string | null;
  /** A sticky status override (pin) is active. */
  pinned: boolean;
  /**
   * Evaluator facts for AQL board filtering; omitted on compute error or for
   * ProjectDetail's summary path (chips-only by design).
   */
  facts?: Record<string, boolean | number | string[]>;
}

export interface TicketBoardItem extends TicketSummary {
  projectSlug: string | null;
  projectTitle: string | null;
  blockedReason: string | null;
  availableTransitions: TicketTransitionAction[];
}

export interface ArchivedTicketItem {
  id: string;
  slug: string;
  title: string;
  status: string;
  type: string | null;
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
  /** Project-level workflow binding (Task 2). */
  defaultWorkflow?: string | null;
  workflowByType?: Record<string, string>;
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
  worktreePath: string | null;
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

export interface TicketDetail {
  id: string;
  projectSlug: string | null;
  slug: string;
  title: string;
  status: string;
  type: string | null;
  /** Explicit `workflow:` override (null → resolved via binding). */
  workflow: string | null;
  /** The workflow id this ticket resolves to. */
  resolvedWorkflow: string;
  /** Human label of the resolved workflow. */
  workflowLabel: string;
  /** Display label of the current status WITHIN the resolved workflow. */
  statusLabel: string;
  priority: TicketSummary['priority'];
  assignee: string | null;
  dependsOn: string[];
  links: string[];
  reverseLinks: string[];
  enrichedLinks: EnrichedLink[];
  blockedReason: string | null;
  workspace: WorkspaceInfo;
  externalIds: ExternalIdInfo[];
  tags: string[];
  archived: boolean;
  archivedAt: string | null;
  archivedReason: string | null;
  created: string;
  updated: string;
  body: string;
  plan: { status: string; updated: string; body: string } | null;
  scratchpad: { updated: string; body: string } | null;
  handoff: { updated: string; handoffCount: number; body: string } | null;
  decisionRecord: { updated: string; decisionCount: number; body: string } | null;
  progress: TicketProgress | null;
  comments: TicketComments | null;
  referencedBy: TicketReference[];
  /** Full per-session stage-attribution history (oldest first); empty when the server's session DB is uninitialized. */
  engagements: EngagementInfo[];
  availableTransitions: TicketTransitionAction[];
  // ── derived-status v3 (server-materialized; may be absent on old servers) ──
  /** Cached phase dimension (null pre-migration). */
  phase?: string | null;
  /** Cached disposition dimension (active|blocked|parked; null pre-migration). */
  disposition?: string | null;
  /** The active sticky pin, when present. */
  override?: { status: string; source: string; reason: string | null; at: string } | null;
  /** Server-materialized derivation: pre-override headline + next action + facts.
   * Null for terminal tickets (derivation defers). */
  derived?: {
    derivedStatus: string;
    nextAction: string | null;
    facts: Record<string, boolean | number | string[]>;
    /** Declared bool/number custom facts only (server pre-separated them). */
    customFacts?: Record<string, boolean | number>;
    /** Per-attestation-fact state with per-actor verdicts + staleness. */
    attestations?: Array<{
      fact: string;
      binds: 'plan' | 'commit' | 'none';
      records: Array<{
        actor: string;
        verdict: 'approved' | 'changes-requested';
        at: string;
        note: string | null;
        stale: boolean;
      }>;
    }>;
  } | null;
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

export interface TicketCommentEntry {
  id: string;
  timestamp: string;
  author: string;
  type: 'question' | 'note' | 'feedback';
  body: string;
  replyTo?: string;
  resolved?: boolean;
}

export interface TicketComments {
  updated: string;
  entryCount: number;
  entries: TicketCommentEntry[];
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
  blockedReason: string | null;
  segment: OverviewSegmentId;
  agingMs: number;
  assignee: string | null;
  availableTransitions: TicketTransitionAction[];
}

export type OverviewHeroKind =
  | 'review'
  | 'ready_to_implement'
  | 'ready_for_planning'
  | 'in_progress'
  | 'draft'
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

interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

function useFetch<T>(
  url: string | null,
  websocketScope?: 'projects' | 'project' | 'ticket' | 'tickets' | 'overview' | 'agent-sessions' | 'playbooks',
  enabled = true,
  // By default `data` is retained across URL changes so filter-driven views
  // (e.g. UsagePage's date range) update smoothly without flashing empty. Set
  // this for entity-keyed fetches where rendering a *previous* entity's data on
  // a new key would be wrong (e.g. ticket-to-ticket navigation).
  resetDataOnUrlChange = false,
): FetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchCount, setFetchCount] = useState(0);
  // Tracks whether `data` is currently populated. Lets a background refetch keep
  // the existing data on screen (stale-while-revalidate) instead of blanking to
  // the loading skeleton. A ref (not state) so the fetch effect can read it
  // without a dependency — which would otherwise cause a refetch loop.
  const hasDataRef = useRef(false);

  // When `enabled` is false the hook is inert (no request fired) — used to defer
  // heavy fetches, e.g. the command palette's indexes until it first opens.
  const activeUrl = enabled ? url : null;

  const refetch = useCallback(() => {
    setFetchCount((count) => count + 1);
  }, []);

  // Drop stale data the moment the target URL changes (opt-in) — DURING render,
  // not in a post-commit effect, so a previous entity's data is never painted on
  // a new key, not even for one frame. This is React's documented "adjust state
  // while rendering" pattern: guarded by a ref so it fires exactly once per URL
  // change (never on `refetch`/websocket-triggered refetches of the same key).
  const lastUrlRef = useRef(activeUrl);
  if (resetDataOnUrlChange && lastUrlRef.current !== activeUrl) {
    lastUrlRef.current = activeUrl;
    setData(null);
    hasDataRef.current = false;
    setError(null);
    // Clearing data + flipping loading together (React's adjust-state-during-
    // render) guarantees the skeleton paints immediately on an entity-key change
    // — no one-frame `data=null`/`loading=false` empty paint for naive gates.
    setLoading(true);
  }

  useEffect(() => {
    if (!activeUrl) {
      setLoading(false);
      setData(null);
      hasDataRef.current = false;
      return;
    }

    let cancelled = false;
    // Stale-while-revalidate: only show the skeleton when there's nothing to
    // display yet (initial load, or a resetDataOnUrlChange reset). Background /
    // same-URL refetches (e.g. WS-triggered) keep current data on screen — this
    // is what stops the periodic "flash."
    setLoading(!hasDataRef.current);
    setError(null);

    fetch(activeUrl)
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.error || `HTTP ${response.status}`);
        }
        return response.json() as Promise<T>;
      })
      .then((json) => {
        if (!cancelled) {
          setData(json);
          hasDataRef.current = true;
          setLoading(false);
        }
      })
      .catch((fetchError: Error) => {
        if (!cancelled) {
          setError(fetchError.message);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeUrl, fetchCount]);

  useWebSocket((message: WsMessage) => {
    if (!websocketScope || !activeUrl) {
      return;
    }

    if (message.type === 'project-updated' || message.type === 'ticket-updated') {
      refetch();
    }

    if (
      message.type === 'agent-sessions-updated'
      && (websocketScope === 'agent-sessions' || websocketScope === 'overview')
    ) {
      // Overview embeds recentSessions, so it must refetch when an agent
      // session is registered/updated.
      refetch();
    }

    if (message.type === 'playbooks-updated' && websocketScope === 'playbooks') {
      refetch();
    }
  });

  return { data, loading, error, refetch };
}

export function useProjects(enabled = true): FetchState<ProjectSummary[]> {
  return useFetch<ProjectSummary[]>('/api/projects', 'projects', enabled);
}

export function useOverview(options: { staleLimit?: number; staleOffset?: number } = {}): FetchState<OverviewResponse> {
  const params = new URLSearchParams();
  if (typeof options.staleLimit === 'number' && Number.isFinite(options.staleLimit)) {
    params.set('staleLimit', String(options.staleLimit));
  }
  if (typeof options.staleOffset === 'number' && Number.isFinite(options.staleOffset)) {
    params.set('staleOffset', String(options.staleOffset));
  }
  const qs = params.toString();
  const url = qs ? `/api/overview?${qs}` : '/api/overview';
  return useFetch<OverviewResponse>(url, 'overview');
}

export function useTicketsBoard(enabled = true): FetchState<TicketsBoardResponse> {
  return useFetch<TicketsBoardResponse>('/api/tickets', 'tickets', enabled);
}

export function useArchived(enabled = true): FetchState<ArchiveResponse> {
  // Refetches on any project/ticket broadcast so a restore elsewhere updates the page.
  return useFetch<ArchiveResponse>('/api/archived', 'tickets', enabled);
}

export function useHelp(): FetchState<HelpResponse> {
  return useFetch<HelpResponse>('/api/help');
}

export function useProject(slug: string | undefined): FetchState<ProjectDetail> {
  const url = slug ? `/api/projects/${slug}` : null;
  // Entity-keyed: reset on URL change so a prior project's data is never painted
  // under a new slug (SWR keeps data across same-URL refetches, which would
  // otherwise mask the wrong entity on navigation).
  return useFetch<ProjectDetail>(url, 'project', true, true);
}

export function useTicket(
  id: string | undefined,
): FetchState<TicketDetail> {
  const url = id ? `/api/tickets/${id}` : null;
  return useFetch<TicketDetail>(url, 'ticket', true, true);
}

/** @deprecated Use {@link useTicket} */
export const useTicketById = useTicket;

export function useEditableDocument(
  url: string | null,
): FetchState<EditableDocumentResponse> {
  // Entity-keyed (per-document): reset on URL change so an edit/append page never
  // shows a prior document's content under a new save URL.
  return useFetch<EditableDocumentResponse>(url, undefined, true, true);
}

/**
 * `includeUsageOnly` opts into synthetic rows for sessions that exist only in
 * usage_events (spend with no tracked session). Off by default so overview
 * rails, widgets, and saved views keep seeing tracked sessions only.
 */
export interface AgentSessionsQuery {
  includeUsageOnly?: boolean;
  /** Presence of `pageSize` is what opts into paging; omit it for the full set. */
  pageSize?: number;
  page?: number;
  search?: string;
  startedFrom?: string;
  startedTo?: string;
  sort?: SessionSort;
  attribution?: SessionAttribution;
  /** Archived visibility. Defaults to 'hide'; only the Agent Sessions page sets it. */
  archived?: ArchivedFilter;
  /**
   * Defer the request until the consumer actually needs it (a dialog opening).
   * Plumbed to useFetch's own `enabled`, the same seam the command palette uses
   * to hold back its indexes.
   */
  enabled?: boolean;
}

export function useAgentSessions(
  options: AgentSessionsQuery = {},
): FetchState<AgentSessionsResponse> {
  const params = new URLSearchParams();
  if (options.includeUsageOnly) params.set('includeUsageOnly', '1');
  if (options.pageSize !== undefined) {
    params.set('pageSize', String(options.pageSize));
    params.set('page', String(options.page ?? 0));
  }
  if (options.search) params.set('search', options.search);
  if (options.startedFrom) params.set('startedFrom', options.startedFrom);
  if (options.startedTo) params.set('startedTo', options.startedTo);
  if (options.sort) params.set('sort', options.sort);
  if (options.attribution) params.set('attribution', options.attribution);
  // Only sent when non-default, so the Overview widget's URL — and therefore its
  // fetch cache key — is unchanged. That is also what keeps the widget on the
  // archived-excluding default without any widget-side code.
  if (options.archived && options.archived !== 'hide') params.set('archived', options.archived);
  // The date filters are LOCAL calendar dates; the server needs the offset to
  // turn them into the right UTC instants (see localDateToUtcBounds). Sent only
  // alongside a date so the URL — and therefore the fetch cache key — is
  // unchanged for every query that does not filter by date.
  //
  // One offset PER DATE, not one for the request: the offset is taken for the
  // filtered date rather than for `now` (filtering a July date while browsing in
  // January would otherwise apply January's offset), and each bound gets its own
  // so a range spanning a DST change is correct at both ends. Midday avoids the
  // ambiguous hour at a transition.
  const offsetForDate = (date: string): string =>
    String(new Date(`${date}T12:00:00`).getTimezoneOffset());
  if (options.startedFrom) params.set('tzOffsetFrom', offsetForDate(options.startedFrom));
  if (options.startedTo) params.set('tzOffsetTo', offsetForDate(options.startedTo));
  const qs = params.toString();
  const url = qs ? `/api/agent-sessions?${qs}` : '/api/agent-sessions';
  // URL-keyed: a websocket 'agent-sessions-updated' broadcast refetches THIS
  // url, so a live update refreshes the current page rather than the full set.
  return useFetch<AgentSessionsResponse>(url, 'agent-sessions', options.enabled ?? true);
}

export function useAgentSession(
  sessionId: string | undefined,
): FetchState<AgentSessionDetailResponse> {
  const url = sessionId ? `/api/agent-sessions/by-id/${sessionId}` : null;
  // Entity-keyed: reset on id change so a previous session's detail is never
  // painted on a new id. WS-refetches on 'agent-sessions-updated' broadcasts.
  return useFetch<AgentSessionDetailResponse>(url, 'agent-sessions', true, true);
}

export function useTicketSessions(
  id: string | undefined,
): FetchState<AgentSessionsResponse> {
  const url = id ? `/api/tickets/${id}/sessions` : null;
  return useFetch<AgentSessionsResponse>(url, 'agent-sessions', true, true);
}

/** @deprecated Use {@link useTicketSessions} */
export const useTicketSessionsById = useTicketSessions;

export interface TicketUsageSummary {
  totalTokens: number;
  totalCost: number;
  lastEventDay: string | null;
  byModel: { model: string; totalTokens: number; totalCost: number }[];
}

export interface TicketUsageResponse {
  summary: TicketUsageSummary;
  // `daily` / `events` are returned for backward compat but unused by the panel.
  daily?: unknown[];
  events?: unknown[];
}

// Usage is read-only and not broadcast over the websocket, so these hooks omit
// the `websocketScope` arg — they fetch once per (project, ticket) and stay
// inert to project/ticket/session broadcasts.
export function useTicketUsage(
  id: string | undefined,
): FetchState<TicketUsageResponse> {
  const url = id ? `/api/tickets/${encodeURIComponent(id)}/usage` : null;
  // resetDataOnUrlChange: never render a prior ticket's totals on a new one.
  return useFetch<TicketUsageResponse>(url, undefined, true, true);
}

/** @deprecated Use {@link useTicketUsage} */
export const useStandaloneTicketUsage = useTicketUsage;

export function usePlaybooks(enabled = true): FetchState<PlaybooksResponse> {
  return useFetch<PlaybooksResponse>('/api/playbooks', 'playbooks', enabled);
}

// --- Overview usage widgets (Token Usage / Spend) ---
// Read-only and not broadcast, so no websocketScope. `resetDataOnUrlChange` is
// true so a filter change never renders the prior filter's totals.
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
}

export interface WorkspaceUsageResponse {
  daily: UsageDailyRow[];
  summary: UsageSummaryRow[];
}

export interface UsageFacets {
  models: string[];
  tools: string[];
}

/** Workspace-wide usage matching a widget's filters. */
export function useUsage(filters: UsageWidgetFilters): FetchState<WorkspaceUsageResponse> {
  const query = buildUsageApiQuery(filters).toString();
  const url = query ? `/api/usage?${query}` : '/api/usage';
  return useFetch<WorkspaceUsageResponse>(url, undefined, true, true);
}

/** Distinct models + tools present in the usage data (for filter dropdowns). */
export function useUsageFacets(enabled = true): FetchState<UsageFacets> {
  return useFetch<UsageFacets>('/api/usage/facets', undefined, enabled);
}

export function usePlaybook(slug: string | undefined): FetchState<PlaybookDetail> {
  const url = slug ? `/api/playbooks/${slug}` : null;
  return useFetch<PlaybookDetail>(url, 'playbooks', true, true);
}
