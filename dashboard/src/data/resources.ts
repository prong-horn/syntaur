/**
 * Typed resource descriptors for every finite GET the dashboard makes, plus the
 * websocket → invalidation matrix.
 *
 * A descriptor's exact canonical `url` is its cache key. Invalidation NEVER
 * infers anything from the URL: each descriptor carries explicit family `tags`
 * and typed `meta` (ticket id / project slug / config kind), and targets match
 * on those. Builders own path-segment encoding and sorted query serialization,
 * so equivalent inputs always produce the identical key; pages never
 * concatenate API URLs.
 */
import type { UsageWidgetFilters } from '@shared/usage-filters';
import { buildUsageApiQuery } from '@shared/usage-filters';
import type { SessionSort } from '@shared/session-sort';
import type { SessionAttribution } from '@shared/session-attribution';
import type { ArchivedFilter } from '@shared/session-archived';
import type { WsMessage } from '../hooks/wsManager';
import type {
  ActivityEvent,
  AgentSessionDetailResponse,
  AgentSessionsResponse,
  ArchiveResponse,
  ContentHit,
  EditableDocumentResponse,
  HelpResponse,
  OverviewResponse,
  PlaybookDetail,
  PlaybooksResponse,
  ProjectDetail,
  ProjectSummary,
  TicketDetail,
  TicketsBoardResponse,
  TicketUsageResponse,
  UsageFacets,
  WorkspaceUsageResponse,
} from './types';
import type { ChatAgentSummary, ChatHarnessSummary } from '../lib/chat-types';

/** Resource families. A descriptor lists every family it belongs to. */
export type ResourceTag =
  | 'board'
  | 'ticket'
  | 'ticket-detail'
  | 'ticket-events'
  | 'ticket-sessions'
  | 'ticket-usage'
  /** Anything carrying read-time cost/session totals (board, detail, ticket usage). */
  | 'metrics'
  | 'projects'
  | 'project'
  | 'archived'
  | 'overview'
  | 'help'
  | 'inbox'
  | 'search'
  | 'sessions'
  | 'session'
  | 'usage'
  | 'playbooks'
  | 'playbook'
  | 'agents'
  | 'harnesses'
  | 'config'
  | 'view-prefs'
  | 'templates'
  | 'document';

export type ConfigKind = 'theme' | 'search' | 'hotkeys';

export interface ResourceMeta {
  /** Primary family, for diagnostics and inventories. */
  readonly kind: ResourceTag;
  readonly ticketId?: string;
  readonly projectSlug?: string;
  readonly configKind?: ConfigKind;
  readonly sessionId?: string;
}

/**
 * Optional shared background refresh: while at least one subscriber is mounted
 * and `while(data)` holds, the store refetches this key every `intervalMs`
 * (one timer per key, never per component; paused while the page is hidden).
 */
export interface RefreshPolicy<T> {
  readonly intervalMs: number;
  // Method syntax (bivariant) so a `Resource<T>` is usable wherever the
  // store holds `Resource<unknown>`.
  while(data: T): boolean;
}

export interface Resource<T> {
  readonly url: string;
  readonly tags: readonly ResourceTag[];
  readonly meta: ResourceMeta;
  readonly refresh?: RefreshPolicy<T>;
  /**
   * `false`: drop the entry as soon as its last subscriber leaves, so the next
   * mount always loads fresh (editors seed local state from the first value
   * and must never start from a pre-save copy). Default: retained.
   */
  readonly retain?: boolean;
  /** Phantom marker carrying the response type; never set at runtime. */
  readonly __data?: T;
}

/** Match entries by family, optionally narrowed by typed metadata. */
export interface InvalidationTarget {
  readonly tag: ResourceTag;
  readonly ticketId?: string;
  readonly projectSlug?: string;
  readonly configKind?: ConfigKind;
}

export function matchesTarget(resource: Resource<unknown>, target: InvalidationTarget): boolean {
  if (!resource.tags.includes(target.tag)) return false;
  if (target.ticketId !== undefined && resource.meta.ticketId !== target.ticketId) return false;
  if (target.projectSlug !== undefined && resource.meta.projectSlug !== target.projectSlug) return false;
  if (target.configKind !== undefined && resource.meta.configKind !== target.configKind) return false;
  return true;
}

type QueryValue = string | number | boolean | readonly (string | number)[] | null | undefined;

/**
 * Canonical `/api/...` URL: each path segment is encoded; query keys are
 * sorted; `undefined`/`null` are omitted while meaningful empty strings,
 * `false` and `0` are preserved; arrays become repeated keys (order kept).
 */
export function apiUrl(segments: readonly string[], query?: Readonly<Record<string, QueryValue>>): string {
  const path = `/api/${segments.map((s) => encodeURIComponent(s)).join('/')}`;
  if (!query) return path;
  const params = new URLSearchParams();
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Canonicalize an existing `?a=..` string (sorted keys, stable order within a key). */
function canonicalQuery(params: URLSearchParams): string {
  const keys = [...new Set(params.keys())].sort();
  const out = new URLSearchParams();
  for (const key of keys) for (const value of params.getAll(key)) out.append(key, value);
  return out.toString();
}

function resource<T>(
  url: string,
  tags: readonly ResourceTag[],
  meta: ResourceMeta,
  refresh?: RefreshPolicy<T>,
): Resource<T> {
  return refresh ? { url, tags, meta, refresh } : { url, tags, meta };
}

const SESSION_REFRESH_MS = 30_000;

/** Sessions lists re-read every 30 s while any row is live (durations/liveness are time-dependent). */
const refreshWhileActiveSessions: RefreshPolicy<AgentSessionsResponse> = {
  intervalMs: SESSION_REFRESH_MS,
  while: (data) => Array.isArray(data?.sessions) && data.sessions.some((s) => s.status === 'active'),
};

export interface InboxQuery {
  project?: string | null;
  maxAgeDays?: number | null;
  includeSnoozed?: boolean;
}

export interface SessionsQuery {
  includeUsageOnly?: boolean;
  /** Presence of `pageSize` is what opts into paging; omit it for the full set. */
  pageSize?: number;
  page?: number;
  search?: string;
  startedFrom?: string;
  startedTo?: string;
  sort?: SessionSort;
  attribution?: SessionAttribution;
  archived?: ArchivedFilter;
}

export interface OverviewQuery {
  staleLimit?: number;
  staleOffset?: number;
}

export interface SearchResponse {
  hits: ContentHit[];
}

export interface TicketEventsResponse {
  events: ActivityEvent[];
}

export interface TicketTemplateSummaryResponse {
  templates: Array<{
    id: string;
    description: string;
    whenToUse?: string;
    builtin?: string;
    driftStatus?: string;
    stageIds?: string[];
    filePaths?: string[];
  }>;
}

function finite(n: number | null | undefined): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/**
 * The date filters are LOCAL calendar dates; the server needs the offset to
 * turn them into the right UTC instants. One offset PER DATE (taken at local
 * midday of that date, so DST transitions resolve correctly at both ends), sent
 * only alongside a date so every undated query keeps the same cache key.
 */
function offsetForDate(date: string): string {
  return String(new Date(`${date}T12:00:00`).getTimezoneOffset());
}

export const resources = {
  tickets: (): Resource<TicketsBoardResponse> =>
    resource(apiUrl(['tickets']), ['board', 'metrics'], { kind: 'board' }),

  ticket: (id: string): Resource<TicketDetail> =>
    resource(apiUrl(['tickets', id]), ['ticket', 'ticket-detail', 'metrics'], { kind: 'ticket-detail', ticketId: id }),

  ticketEvents: (id: string): Resource<TicketEventsResponse> =>
    resource(apiUrl(['tickets', id, 'events']), ['ticket', 'ticket-events'], { kind: 'ticket-events', ticketId: id }),

  ticketSessions: (id: string): Resource<AgentSessionsResponse> =>
    resource(apiUrl(['tickets', id, 'sessions']), ['ticket', 'ticket-sessions', 'sessions'], {
      kind: 'ticket-sessions',
      ticketId: id,
    }),

  ticketUsage: (id: string): Resource<TicketUsageResponse> =>
    resource(apiUrl(['tickets', id, 'usage']), ['ticket', 'ticket-usage', 'usage', 'metrics'], {
      kind: 'ticket-usage',
      ticketId: id,
    }),

  projects: (): Resource<ProjectSummary[]> => resource(apiUrl(['projects']), ['projects'], { kind: 'projects' }),

  archived: (): Resource<ArchiveResponse> => resource(apiUrl(['archived']), ['archived'], { kind: 'archived' }),

  project: (slug: string): Resource<ProjectDetail> =>
    resource(apiUrl(['projects', slug]), ['project'], { kind: 'project', projectSlug: slug }),

  overview: (query: OverviewQuery = {}): Resource<OverviewResponse> =>
    resource(
      apiUrl(['overview'], { staleLimit: finite(query.staleLimit), staleOffset: finite(query.staleOffset) }),
      ['overview'],
      { kind: 'overview' },
    ),

  help: (): Resource<HelpResponse> => resource(apiUrl(['help']), ['help'], { kind: 'help' }),

  inbox: (query: InboxQuery = {}): Resource<import('../lib/inbox').InboxResult> =>
    resource(
      apiUrl(['inbox'], {
        project: query.project || undefined,
        maxAgeDays: query.maxAgeDays != null && query.maxAgeDays > 0 ? query.maxAgeDays : undefined,
        includeSnoozed: query.includeSnoozed ? '1' : undefined,
      }),
      ['inbox'],
      { kind: 'inbox', ...(query.project ? { projectSlug: query.project } : {}) },
    ),

  search: (q: string): Resource<SearchResponse> => resource(apiUrl(['search'], { q }), ['search'], { kind: 'search' }),

  sessions: (query: SessionsQuery = {}): Resource<AgentSessionsResponse> =>
    resource(
      apiUrl(['agent-sessions'], {
        includeUsageOnly: query.includeUsageOnly ? '1' : undefined,
        pageSize: query.pageSize,
        page: query.pageSize !== undefined ? query.page ?? 0 : undefined,
        search: query.search || undefined,
        startedFrom: query.startedFrom || undefined,
        startedTo: query.startedTo || undefined,
        tzOffsetFrom: query.startedFrom ? offsetForDate(query.startedFrom) : undefined,
        tzOffsetTo: query.startedTo ? offsetForDate(query.startedTo) : undefined,
        sort: query.sort,
        attribution: query.attribution,
        // Only sent when non-default so the default list keeps one cache key.
        archived: query.archived && query.archived !== 'hide' ? query.archived : undefined,
      }),
      ['sessions'],
      { kind: 'sessions' },
      refreshWhileActiveSessions,
    ),

  session: (sessionId: string): Resource<AgentSessionDetailResponse> =>
    resource(apiUrl(['agent-sessions', 'by-id', sessionId]), ['sessions', 'session'], { kind: 'session', sessionId }),

  usage: (filters: UsageWidgetFilters): Resource<WorkspaceUsageResponse> => {
    const qs = canonicalQuery(buildUsageApiQuery(filters));
    return resource(qs ? `${apiUrl(['usage'])}?${qs}` : apiUrl(['usage']), ['usage'], { kind: 'usage' });
  },

  usageFacets: (): Resource<UsageFacets> => resource(apiUrl(['usage', 'facets']), ['usage'], { kind: 'usage' }),

  playbooks: (): Resource<PlaybooksResponse> => resource(apiUrl(['playbooks']), ['playbooks'], { kind: 'playbooks' }),

  playbook: (slug: string): Resource<PlaybookDetail> =>
    resource(apiUrl(['playbooks', slug]), ['playbooks', 'playbook'], { kind: 'playbook' }),

  agents: (): Resource<{ agents: ChatAgentSummary[]; errors: string[] }> =>
    resource(apiUrl(['chat', 'agents']), ['agents'], { kind: 'agents' }),

  harnesses: (): Resource<{ harnesses: ChatHarnessSummary[] }> =>
    resource(apiUrl(['chat', 'harnesses']), ['agents', 'harnesses'], { kind: 'harnesses' }),

  config: <T = unknown>(kind: ConfigKind): Resource<T> =>
    resource(apiUrl(['config', kind]), ['config'], { kind: 'config', configKind: kind }),

  viewPrefs: <T = unknown>(): Resource<T> => resource(apiUrl(['view-prefs']), ['view-prefs'], { kind: 'view-prefs' }),

  templates: (): Resource<TicketTemplateSummaryResponse> =>
    resource(apiUrl(['ticket-templates']), ['templates'], { kind: 'templates' }),

  /**
   * An editable document's load URL. Editors own unsaved text, so documents are
   * deliberately NOT refreshed by websocket traffic, and are not retained after
   * the editor unmounts (reopening always loads the saved content).
   */
  document: (url: string): Resource<EditableDocumentResponse> => {
    if (!url.startsWith('/api/')) throw new Error(`document resource must be an /api/ URL: ${url}`);
    return { url, tags: ['document'], meta: { kind: 'document' }, retain: false };
  },
} as const;

// --- invalidation ----------------------------------------------------------

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,199}$/;

/** A ticket id / project slug usable for targeted matching, else undefined. */
export function validScopeId(value: unknown): string | undefined {
  return typeof value === 'string' && ID_RE.test(value) ? value : undefined;
}

/** Families touched by any write to one ticket (verbs, log, rename, delete, create…). */
export function ticketWriteTargets(ticketId?: string, projectSlug?: string | null): InvalidationTarget[] {
  const id = validScopeId(ticketId);
  const slug = validScopeId(projectSlug ?? undefined);
  return [
    id ? { tag: 'ticket', ticketId: id } : { tag: 'ticket' },
    { tag: 'board' },
    { tag: 'projects' },
    slug ? { tag: 'project', projectSlug: slug } : { tag: 'project' },
    { tag: 'archived' },
    { tag: 'inbox' },
    { tag: 'search' },
    { tag: 'overview' },
  ];
}

/** Families touched by project writes (create/edit/archive/restore). */
export function projectWriteTargets(projectSlug?: string | null): InvalidationTarget[] {
  const slug = validScopeId(projectSlug ?? undefined);
  return [
    { tag: 'projects' },
    { tag: 'archived' },
    slug ? { tag: 'project', projectSlug: slug } : { tag: 'project' },
    { tag: 'board' },
    { tag: 'inbox' },
    { tag: 'search' },
    { tag: 'overview' },
  ];
}

export const agentWriteTargets: readonly InvalidationTarget[] = [{ tag: 'agents' }, { tag: 'ticket-detail' }];
export const playbookWriteTargets: readonly InvalidationTarget[] = [{ tag: 'playbooks' }];
export const sessionWriteTargets: readonly InvalidationTarget[] = [
  { tag: 'sessions' },
  { tag: 'usage' },
  { tag: 'metrics' },
  { tag: 'overview' },
];

function payloadTicketId(message: WsMessage): string | undefined {
  const payload = message.payload as { ticketId?: unknown } | null | undefined;
  return validScopeId(payload?.ticketId);
}

/**
 * The websocket invalidation matrix. Chat deltas (`chat-item`, `chat-session`)
 * are reduced by the chat state machine and invalidate nothing here; the
 * initial `connected` frame invalidates nothing (reconnects are signalled
 * separately by wsManager).
 */
export function invalidationsForMessage(message: WsMessage): InvalidationTarget[] {
  switch (message.type) {
    case 'ticket-updated': {
      const id = validScopeId(message.ticketId);
      const slug = validScopeId(message.projectSlug ?? undefined);
      return [
        id ? { tag: 'ticket', ticketId: id } : { tag: 'ticket' },
        { tag: 'board' },
        { tag: 'projects' },
        slug ? { tag: 'project', projectSlug: slug } : { tag: 'project' },
        { tag: 'archived' },
        { tag: 'inbox' },
        { tag: 'search' },
        { tag: 'overview' },
      ];
    }
    case 'project-updated':
      return projectWriteTargets(message.projectSlug);
    case 'agent-sessions-updated':
      return [...sessionWriteTargets];
    case 'playbooks-updated':
      return [{ tag: 'playbooks' }];
    case 'stage-dispatch': {
      const id = payloadTicketId(message);
      return [id ? { tag: 'ticket-detail', ticketId: id } : { tag: 'ticket-detail' }, { tag: 'inbox' }];
    }
    case 'chat-agents':
    case 'agents-updated':
      return [...agentWriteTargets];
    case 'chat-participants': {
      const id = payloadTicketId(message);
      return [{ tag: 'agents' }, ...(id ? [{ tag: 'ticket-detail' as const, ticketId: id }] : [])];
    }
    case 'config-updated': {
      const kind = (message.payload as { kind?: unknown } | null | undefined)?.kind;
      if (kind === 'view-prefs') return [{ tag: 'view-prefs' }];
      if (kind === 'config') return [{ tag: 'config' }];
      return [{ tag: 'config' }, { tag: 'view-prefs' }];
    }
    case 'templates-updated':
      // Template edits change stage sets and available verbs on tickets too.
      return [{ tag: 'templates' }, { tag: 'board' }, { tag: 'ticket-detail' }];
    case 'chat-item':
    case 'chat-session':
    case 'connected':
    default:
      return [];
  }
}
