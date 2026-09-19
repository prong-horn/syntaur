/**
 * Sessions family resource descriptors and mutations.
 * Wraps the shared store builders without editing `resources.ts`.
 */
import { buildUsageApiQuery, type UsageWidgetFilters } from '@shared/usage-filters';
import { mutate } from './mutate';
import { apiUrl, resources, sessionWriteTargets, type Resource, type SessionsQuery } from './resources';
import type { AgentSessionDetailResponse, AgentSessionsResponse, WorkspaceUsageResponse } from './types';
import type { UsageGroupBy } from '../lib/usageUrlState';

function usageListUrl(filters: UsageWidgetFilters, groupBy: UsageGroupBy = 'project'): string {
  const params = buildUsageApiQuery(filters);
  if (groupBy === 'ticket') params.set('groupBy', 'ticket');
  const qs = params.toString();
  return qs ? `${apiUrl(['usage'])}?${qs}` : apiUrl(['usage']);
}

export function sessionsList(query: SessionsQuery = {}): Resource<AgentSessionsResponse> {
  return resources.sessions(query);
}

export function sessionDetail(sessionId: string): Resource<AgentSessionDetailResponse> {
  return resources.session(sessionId);
}

export function workspaceUsage(
  filters: UsageWidgetFilters,
  groupBy: UsageGroupBy = 'project',
): Resource<WorkspaceUsageResponse> {
  return {
    url: usageListUrl(filters, groupBy),
    tags: ['usage'],
    meta: { kind: 'usage' },
  };
}

export function usageFacets() {
  return resources.usageFacets();
}

export async function deleteAgentSessions(sessionIds: string[]): Promise<void> {
  await mutate('DELETE', apiUrl(['agent-sessions']), { sessionIds }, { invalidates: sessionWriteTargets });
}

export async function markSessionStopped(sessionId: string): Promise<void> {
  await mutate(
    'PATCH',
    apiUrl(['agent-sessions', sessionId]),
    { status: 'stopped' },
    { invalidates: sessionWriteTargets },
  );
}

export async function patchSessionCuration(
  sessionId: string,
  body: { pinned?: boolean; archived?: boolean; name?: string | null },
): Promise<void> {
  await mutate(
    'PATCH',
    apiUrl(['agent-sessions', sessionId, 'curation']),
    body,
    { invalidates: sessionWriteTargets },
  );
}

export { sessionWriteTargets };
