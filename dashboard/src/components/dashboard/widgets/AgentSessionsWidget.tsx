import { useAgentSessions } from '../../../hooks/useProjects';
import { RecentSessionsRail } from '../../RecentSessionsRail';
import { LoadingState } from '../../LoadingState';

export function AgentSessionsWidget() {
  const { data, loading, error } = useAgentSessions();

  if (loading && !data) {
    return <LoadingState label="Loading sessions…" />;
  }

  if (error) {
    return (
      <div className="rounded-lg border border-border/60 bg-card/85 px-4 py-3 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">Couldn't load sessions</p>
        <p className="mt-1 text-xs">{error}</p>
      </div>
    );
  }

  return <RecentSessionsRail sessions={data?.sessions ?? []} />;
}
