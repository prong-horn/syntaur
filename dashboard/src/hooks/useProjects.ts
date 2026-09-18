/**
 * Compatibility wrappers over the shared resource store (`data/`). Each hook is
 * a one-line `useResource(resources.x(...))` adapted to the legacy
 * `{ data: T | null, loading, error: string | null, refetch }` shape that the
 * pre-SV-12 pages consume. There is no second fetch/cache here: every call
 * shares the store's per-URL entry, in-flight GET and websocket invalidation.
 * New code should call `useResource` directly.
 */
import { useMemo } from 'react';
import type { UsageWidgetFilters } from '@shared/usage-filters';
import { useResource, type ResourceState } from '../data/useResource';
import { resources, type Resource, type SessionsQuery } from '../data/resources';
import type {
  AgentSessionDetailResponse,
  AgentSessionsResponse,
  ArchiveResponse,
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
} from '../data/types';

// Response types live in `data/types.ts`; re-exported for existing importers.
export * from '../data/types';

export interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/** Adapt a resource state to the legacy page-facing shape. */
export function toFetchState<T>(state: ResourceState<T>): FetchState<T> {
  return {
    data: state.data ?? null,
    loading: state.loading,
    error: state.error ? state.error.message : null,
    refetch: state.refetch,
  };
}

function useLegacyResource<T>(resource: Resource<T> | null): FetchState<T> {
  const state = useResource(resource);
  return useMemo(() => toFetchState(state), [state]);
}

export function useProjects(enabled = true): FetchState<ProjectSummary[]> {
  return useLegacyResource(enabled ? resources.projects() : null);
}

export function useOverview(options: { staleLimit?: number; staleOffset?: number } = {}): FetchState<OverviewResponse> {
  return useLegacyResource(resources.overview(options));
}

export function useTicketsBoard(enabled = true): FetchState<TicketsBoardResponse> {
  return useLegacyResource(enabled ? resources.tickets() : null);
}

export function useArchived(enabled = true): FetchState<ArchiveResponse> {
  return useLegacyResource(enabled ? resources.archived() : null);
}

export function useHelp(): FetchState<HelpResponse> {
  return useLegacyResource(resources.help());
}

export function useProject(slug: string | undefined): FetchState<ProjectDetail> {
  return useLegacyResource(slug ? resources.project(slug) : null);
}

export function useTicket(id: string | undefined): FetchState<TicketDetail> {
  return useLegacyResource(id ? resources.ticket(id) : null);
}

/** @deprecated Use {@link useTicket} */
export const useTicketById = useTicket;

export function useEditableDocument(url: string | null): FetchState<EditableDocumentResponse> {
  return useLegacyResource(url ? resources.document(url) : null);
}

/**
 * `includeUsageOnly` opts into synthetic rows for sessions that exist only in
 * usage_events (spend with no tracked session). Off by default so overview
 * rails, widgets, and saved views keep seeing tracked sessions only.
 */
export interface AgentSessionsQuery extends SessionsQuery {
  /** Defer the request until the consumer actually needs it (a dialog opening). */
  enabled?: boolean;
}

export function useAgentSessions(options: AgentSessionsQuery = {}): FetchState<AgentSessionsResponse> {
  const { enabled = true, ...query } = options;
  return useLegacyResource(enabled ? resources.sessions(query) : null);
}

export function useAgentSession(sessionId: string | undefined): FetchState<AgentSessionDetailResponse> {
  return useLegacyResource(sessionId ? resources.session(sessionId) : null);
}

export function useTicketSessions(id: string | undefined): FetchState<AgentSessionsResponse> {
  return useLegacyResource(id ? resources.ticketSessions(id) : null);
}

/** @deprecated Use {@link useTicketSessions} */
export const useTicketSessionsById = useTicketSessions;

export function useTicketUsage(id: string | undefined): FetchState<TicketUsageResponse> {
  return useLegacyResource(id ? resources.ticketUsage(id) : null);
}

/** @deprecated Use {@link useTicketUsage} */
export const useStandaloneTicketUsage = useTicketUsage;

export function usePlaybooks(enabled = true): FetchState<PlaybooksResponse> {
  return useLegacyResource(enabled ? resources.playbooks() : null);
}

/** Workspace-wide usage matching a widget's filters. */
export function useUsage(filters: UsageWidgetFilters): FetchState<WorkspaceUsageResponse> {
  return useLegacyResource(resources.usage(filters));
}

/** Distinct models + tools present in the usage data (for filter dropdowns). */
export function useUsageFacets(enabled = true): FetchState<UsageFacets> {
  return useLegacyResource(enabled ? resources.usageFacets() : null);
}

export function usePlaybook(slug: string | undefined): FetchState<PlaybookDetail> {
  return useLegacyResource(slug ? resources.playbook(slug) : null);
}
