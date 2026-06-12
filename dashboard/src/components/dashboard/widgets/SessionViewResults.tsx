import { useMemo } from 'react';
import { useAgentSessions } from '../../../hooks/useProjects';
import type { AgentSessionWithLiveness } from '../../../types';
import { toFilterValues } from '@shared/view-prefs-schema';
import { filterSessions, sortSessions, applySessionLimit } from '../../../lib/sessionFilters';
import { LoadingState } from '../../LoadingState';
import { EmptyState } from '../../EmptyState';
import { RecentSessionsRail } from '../../RecentSessionsRail';
import type { SavedView } from '@shared/saved-views-schema';

interface SessionViewResultsProps {
  view: SavedView;
  compact?: boolean;
  emptyDescription?: string;
}

/**
 * Overview dashboard slot body for a session saved view. Owns the full
 * data lifecycle: fetch all sessions → filter → sort → limit → render.
 * Used by `AgentSessionsWidget` when it is bound to a session view.
 */
export function SessionViewResults({
  view,
  emptyDescription,
}: SessionViewResultsProps) {
  const { data, loading, error } = useAgentSessions();

  const filtered = useMemo(() => {
    if (!data) return [];
    const sessions: AgentSessionWithLiveness[] = data.sessions ?? [];

    const { config } = view;
    const f = config.filters;

    const options = {
      // Decision 6: always treat dateRange as targeting `started`,
      // regardless of the stored `field` value.
      dateRange: f.dateRange ? { ...f.dateRange, field: 'started' as const } : undefined,
      project: toFilterValues(f.project),
      agent: toFilterValues(f.agent),
      sessionStatus: toFilterValues(f.sessionStatus),
      limit: config.limit,
    };

    let result = filterSessions(sessions, options);
    result = sortSessions(result, config.sortField, config.sortDirection);
    result = applySessionLimit(result, config.limit);
    return result;
  }, [data, view]);

  if (loading && !data) {
    return <LoadingState label="Loading sessions…" />;
  }

  if (error) {
    return (
      <div className="rounded-lg border border-border/60 bg-card/85 px-4 py-3 text-sm">
        <p className="font-medium text-foreground">Couldn't load sessions</p>
        <p className="mt-1 text-xs text-muted-foreground">{error}</p>
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <EmptyState
        title="No sessions match this view."
        description={
          emptyDescription ??
          "Adjust the view's filters to surface different sessions."
        }
      />
    );
  }

  // Compact widget mode reuses RecentSessionsRail styling.
  // Non-compact (future full-page) can add a header above the rail.
  return <RecentSessionsRail sessions={filtered} />;
}
