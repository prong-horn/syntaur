import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ClipboardCheck,
  FolderKanban,
  Gauge,
  Monitor,
  OctagonX,
} from 'lucide-react';
import { useHelp, useOverview } from '../hooks/useMissions';
import { formatDateTime } from '../lib/format';
import { StatusBadge } from '../components/StatusBadge';
import { PageHeader } from '../components/PageHeader';
import { StatCard } from '../components/StatCard';
import { SectionCard } from '../components/SectionCard';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { GettingStartedCard } from '../components/GettingStartedCard';

export function Overview() {
  const { data: overview, loading, error } = useOverview();
  const { data: help } = useHelp();

  if (loading) {
    return <LoadingState label="Loading overview…" />;
  }

  if (error || !overview) {
    return <ErrorState error={error || 'Overview data is unavailable.'} />;
  }

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Command Center"
        title="Overview"
        description="A source-first view of the work on disk, built for triage, onboarding, and keeping first-time users oriented."
        actions={
          <Link className="shell-action bg-foreground text-background hover:opacity-90" to="/create/mission">
            New Mission
          </Link>
        }
      />

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        <StatCard label="Active Missions" value={overview.stats.activeMissions} icon={FolderKanban} />
        <StatCard label="In Progress" value={overview.stats.inProgressAssignments} icon={Gauge} tone="info" />
        <StatCard label="Blocked" value={overview.stats.blockedAssignments} icon={AlertTriangle} tone="warn" />
        <StatCard label="Review" value={overview.stats.reviewAssignments} icon={ClipboardCheck} tone="info" />
        <StatCard label="Failed" value={overview.stats.failedAssignments} icon={OctagonX} tone="danger" />
        <StatCard label="Stale" value={overview.stats.staleAssignments} icon={Activity} />
        {overview.serverStats && (
          <Link to="/servers">
            <StatCard
              label="Active Servers"
              value={overview.serverStats.aliveSessions}
              description={`${overview.serverStats.totalPorts} ports · ${overview.serverStats.deadSessions > 0 ? `${overview.serverStats.deadSessions} dead` : 'all healthy'}`}
              icon={Monitor}
              tone={overview.serverStats.deadSessions > 0 ? 'warn' : 'default'}
            />
          </Link>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
        <div className="space-y-4">
          <SectionCard
            title="Needs Attention Now"
            description="Blocked, failed, review, and stale work from the source files."
          >
            {overview.attention.length === 0 ? (
              <EmptyState
                title="Nothing urgent right now"
                description="The attention queue is empty. Overview will surface blocked, failed, review, and stale assignments here."
              />
            ) : (
              <div className="space-y-3">
                {overview.attention.map((item) => (
                  <Link
                    key={item.id}
                    to={item.href}
                    className="block rounded-md border border-border/60 bg-background/80 p-3 transition hover:border-primary/40 hover:bg-background"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1">
                        <p className="text-sm font-semibold text-foreground">{item.assignmentTitle}</p>
                        <p className="text-sm text-muted-foreground">{item.missionTitle}</p>
                      </div>
                      <StatusBadge status={item.status} />
                    </div>
                    <p className="mt-3 text-sm leading-6 text-muted-foreground">{item.reason}</p>
                    <p className="mt-2 text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground">
                      Updated {formatDateTime(item.updated)}
                    </p>
                  </Link>
                ))}
              </div>
            )}
          </SectionCard>

          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard title="Recently Updated Missions">
              {overview.recentMissions.length === 0 ? (
                <EmptyState
                  title="No missions yet"
                  description="Create your first mission to populate the mission directory, recent activity, and attention queue."
                  actions={
                    <Link className="shell-action bg-foreground text-background hover:opacity-90" to="/create/mission">
                      Create Mission
                    </Link>
                  }
                />
              ) : (
                <div className="space-y-3">
                  {overview.recentMissions.map((mission) => (
                    <Link
                      key={mission.slug}
                      to={`/missions/${mission.slug}`}
                      className="block rounded-md border border-border/60 bg-background/80 p-3 transition hover:border-primary/40"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="font-semibold text-foreground">{mission.title}</h3>
                          <p className="mt-1 text-sm text-muted-foreground">{formatDateTime(mission.updated)}</p>
                        </div>
                        <StatusBadge status={mission.status} />
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </SectionCard>

            <SectionCard title="Recent Activity">
              {overview.recentActivity.length === 0 ? (
                <EmptyState
                  title="No activity yet"
                  description="Once missions and assignments exist, Overview will show activity based on parsed source timestamps instead of file mtimes."
                />
              ) : (
                <div className="space-y-3">
                  {overview.recentActivity.map((item) => (
                    <Link
                      key={item.id}
                      to={item.href}
                      className="block rounded-md border border-border/60 bg-background/80 p-3 transition hover:border-primary/40"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1">
                          <p className="font-semibold text-foreground">{item.title}</p>
                          <p className="text-sm text-muted-foreground">{item.summary}</p>
                        </div>
                        <span className="text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground">
                          {item.type}
                        </span>
                      </div>
                      <p className="mt-3 text-xs text-muted-foreground">{formatDateTime(item.updated)}</p>
                    </Link>
                  ))}
                </div>
              )}
            </SectionCard>
          </div>
        </div>

        {overview.firstRun && <GettingStartedCard help={help} />}
      </div>
    </div>
  );
}
