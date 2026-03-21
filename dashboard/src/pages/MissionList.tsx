import { Link } from 'react-router-dom';
import { useMissions } from '../hooks/useMissions';
import { StatusBadge } from '../components/StatusBadge';
import { ProgressBar } from '../components/ProgressBar';

export function MissionList() {
  const { data: missions, loading, error } = useMissions();

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-muted-foreground">Loading missions...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-red-400">Failed to load missions: {error}</p>
      </div>
    );
  }

  if (!missions || missions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-2">
        <p className="text-muted-foreground text-lg">No missions found.</p>
        <p className="text-muted-foreground text-sm">
          Create a mission with <code className="text-foreground">syntaur create-mission</code>
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">Missions</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {missions.map((mission) => (
          <Link
            key={mission.slug}
            to={`/missions/${mission.slug}`}
            className="group rounded-lg border border-border bg-card p-5 transition-colors hover:border-primary/50"
          >
            <div className="mb-3 flex items-start justify-between gap-2">
              <h2 className="font-semibold text-foreground group-hover:text-primary">
                {mission.title}
              </h2>
              <StatusBadge status={mission.status} />
            </div>

            <ProgressBar progress={mission.progress} className="mb-3" />

            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {mission.progress.completed}/{mission.progress.total} complete
              </span>
              {(mission.needsAttention.blockedCount > 0 ||
                mission.needsAttention.failedCount > 0 ||
                mission.needsAttention.unansweredQuestions > 0) && (
                <span className="text-amber-400">
                  Needs attention
                </span>
              )}
            </div>

            <div className="mt-2 text-xs text-muted-foreground">
              {mission.tags.length > 0 && (
                <span>{mission.tags.join(', ')}</span>
              )}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
