import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity } from 'lucide-react';
import { useAgentSessions } from '../hooks/useMissions';
import { PageHeader } from '../components/PageHeader';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { StatusBadge } from '../components/StatusBadge';
import { formatDateTime } from '../lib/format';
import type { AgentSession, AgentSessionStatus } from '../types';

const STATUS_FILTERS: Array<{ label: string; value: AgentSessionStatus | 'all' }> = [
  { label: 'All', value: 'all' },
  { label: 'Active', value: 'active' },
  { label: 'Completed', value: 'completed' },
  { label: 'Stopped', value: 'stopped' },
];

export function AgentSessionsPage() {
  const { data, loading, error } = useAgentSessions();
  const [statusFilter, setStatusFilter] = useState<AgentSessionStatus | 'all'>('all');

  if (loading) return <LoadingState label="Loading agent sessions..." />;
  if (error) return <ErrorState error={error} />;
  if (!data) return null;

  const filtered =
    statusFilter === 'all'
      ? data.sessions
      : data.sessions.filter((s) => s.status === statusFilter);

  // Group by mission
  const byMission = new Map<string, AgentSession[]>();
  for (const session of filtered) {
    const existing = byMission.get(session.missionSlug) ?? [];
    existing.push(session);
    byMission.set(session.missionSlug, existing);
  }

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Agent Sessions"
        actions={
          <div className="flex items-center gap-1">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.value}
                className={`shell-action ${statusFilter === f.value ? 'border-primary/50 bg-primary/10 text-primary' : ''}`}
                onClick={() => setStatusFilter(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>
        }
      />

      {filtered.length === 0 ? (
        <EmptyState
          title="No agent sessions"
          description={
            statusFilter === 'all'
              ? 'No agent sessions have been registered yet. Use /grab-assignment or syntaur track-session to register one.'
              : `No ${statusFilter} sessions found.`
          }
        />
      ) : (
        <div className="mt-4 space-y-6">
          {Array.from(byMission.entries()).map(([missionSlug, sessions]) => (
            <div key={missionSlug}>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <Link to={`/missions/${missionSlug}`} className="hover:text-foreground">
                  {missionSlug}
                </Link>
              </h3>
              <div className="surface-panel">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                      <th className="pb-2 pr-3">Assignment</th>
                      <th className="pb-2 pr-3">Agent</th>
                      <th className="pb-2 pr-3">Session ID</th>
                      <th className="pb-2 pr-3">Started</th>
                      <th className="pb-2 pr-3">Status</th>
                      <th className="pb-2">Path</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((session) => (
                      <SessionRow key={session.sessionId} session={session} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function SessionRow({ session }: { session: AgentSession }) {
  const shortId = session.sessionId.length > 12
    ? session.sessionId.slice(0, 8) + '...'
    : session.sessionId;
  const shortPath = session.path
    ? session.path.replace(/^\/Users\/[^/]+/, '~')
    : '\u2014';

  return (
    <tr className="border-b border-border/20 last:border-0">
      <td className="py-2 pr-3">
        <Link
          to={`/missions/${session.missionSlug}/assignments/${session.assignmentSlug}`}
          className="text-primary hover:underline"
        >
          {session.assignmentSlug}
        </Link>
      </td>
      <td className="py-2 pr-3">
        <span className="inline-flex items-center gap-1.5">
          <Activity className="h-3 w-3 text-muted-foreground" />
          {session.agent}
        </span>
      </td>
      <td className="py-2 pr-3">
        <span className="font-mono text-xs text-muted-foreground" title={session.sessionId}>
          {shortId}
        </span>
      </td>
      <td className="py-2 pr-3 text-xs text-muted-foreground">
        {formatDateTime(session.started)}
      </td>
      <td className="py-2 pr-3">
        <StatusBadge status={session.status} />
      </td>
      <td className="max-w-[200px] truncate py-2 text-xs text-muted-foreground" title={session.path}>
        {shortPath}
      </td>
    </tr>
  );
}
