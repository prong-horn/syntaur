import { useParams, Link } from 'react-router-dom';
import { useMission } from '../hooks/useMissions';
import { StatusBadge } from '../components/StatusBadge';
import { ProgressBar } from '../components/ProgressBar';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import { DependencyGraph } from '../components/DependencyGraph';

export function MissionDetail() {
  const { slug } = useParams<{ slug: string }>();
  const { data: mission, loading, error } = useMission(slug);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-muted-foreground">Loading mission...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-red-400">Failed to load mission: {error}</p>
      </div>
    );
  }

  if (!mission) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-muted-foreground">Mission not found.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-2xl font-bold text-foreground">{mission.title}</h1>
          <StatusBadge status={mission.status} />
        </div>
        <div className="mt-2 flex items-center gap-4 text-sm text-muted-foreground">
          <span>Created: {new Date(mission.created).toLocaleDateString()}</span>
          <span>Updated: {new Date(mission.updated).toLocaleDateString()}</span>
          {mission.tags.length > 0 && (
            <span>Tags: {mission.tags.join(', ')}</span>
          )}
        </div>
        <ProgressBar progress={mission.progress} className="mt-4" />
        <div className="mt-1 text-xs text-muted-foreground">
          {mission.progress.completed}/{mission.progress.total} assignments complete
        </div>
      </div>

      {/* Needs Attention */}
      {(mission.needsAttention.blockedCount > 0 ||
        mission.needsAttention.failedCount > 0 ||
        mission.needsAttention.unansweredQuestions > 0) && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
          <h2 className="mb-2 font-semibold text-amber-400">Needs Attention</h2>
          <ul className="space-y-1 text-sm text-amber-300">
            {mission.needsAttention.blockedCount > 0 && (
              <li>{mission.needsAttention.blockedCount} blocked assignment(s)</li>
            )}
            {mission.needsAttention.failedCount > 0 && (
              <li>{mission.needsAttention.failedCount} failed assignment(s)</li>
            )}
            {mission.needsAttention.unansweredQuestions > 0 && (
              <li>{mission.needsAttention.unansweredQuestions} unanswered question(s)</li>
            )}
          </ul>
        </div>
      )}

      {/* Assignments Table */}
      <div>
        <h2 className="mb-4 text-lg font-semibold text-foreground">Assignments</h2>
        {mission.assignments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No assignments yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-card">
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Title</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Priority</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Assignee</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Dependencies</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Updated</th>
                </tr>
              </thead>
              <tbody>
                {mission.assignments.map((a) => (
                  <tr
                    key={a.slug}
                    className="border-b border-border last:border-0 hover:bg-accent/50"
                  >
                    <td className="px-4 py-3">
                      <Link
                        to={`/missions/${mission.slug}/assignments/${a.slug}`}
                        className="text-foreground hover:text-primary"
                      >
                        {a.title}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={a.status} />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground capitalize">{a.priority}</td>
                    <td className="px-4 py-3 text-muted-foreground">{a.assignee ?? '\u2014'}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {a.dependsOn.length > 0 ? a.dependsOn.join(', ') : '\u2014'}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {a.updated ? new Date(a.updated).toLocaleDateString() : '\u2014'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Dependency Graph */}
      {mission.dependencyGraph && (
        <div>
          <h2 className="mb-4 text-lg font-semibold text-foreground">Dependency Graph</h2>
          <DependencyGraph definition={mission.dependencyGraph} />
        </div>
      )}

      {/* Resources */}
      {mission.resources.length > 0 && (
        <div>
          <h2 className="mb-4 text-lg font-semibold text-foreground">Resources</h2>
          <div className="space-y-2">
            {mission.resources.map((r) => (
              <div
                key={r.slug}
                className="rounded-lg border border-border bg-card p-3"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-foreground">{r.name}</span>
                  <span className="text-xs text-muted-foreground">{r.category}</span>
                </div>
                {r.relatedAssignments.length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Related: {r.relatedAssignments.join(', ')}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Memories */}
      {mission.memories.length > 0 && (
        <div>
          <h2 className="mb-4 text-lg font-semibold text-foreground">Memories</h2>
          <div className="space-y-2">
            {mission.memories.map((m) => (
              <div
                key={m.slug}
                className="rounded-lg border border-border bg-card p-3"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-foreground">{m.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {m.scope} &middot; {m.source}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Mission Body */}
      {mission.body && (
        <div>
          <h2 className="mb-4 text-lg font-semibold text-foreground">Overview</h2>
          <MarkdownRenderer content={mission.body} />
        </div>
      )}
    </div>
  );
}
