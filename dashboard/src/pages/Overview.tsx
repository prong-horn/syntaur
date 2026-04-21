import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  CheckSquare,
  ClipboardCheck,
  FolderKanban,
  Gauge,
  Monitor,
  OctagonX,
} from 'lucide-react';
import { useHelp, useOverview } from '../hooks/useProjects';
import { useAllTodos } from '../hooks/useTodos';
import { formatDateTime, toTitleCase } from '../lib/format';
import { StatusBadge } from '../components/StatusBadge';
import { StatCard } from '../components/StatCard';
import { SectionCard } from '../components/SectionCard';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { GettingStartedCard } from '../components/GettingStartedCard';

export function Overview() {
  const { data: overview, loading, error } = useOverview();
  const { data: help } = useHelp();
  const { data: todosData } = useAllTodos();

  const openTodos = todosData?.workspaces
    ? todosData.workspaces.reduce((sum, ws) => sum + ws.counts.open + ws.counts.in_progress, 0)
    : 0;

  if (loading) {
    return <LoadingState label="Loading overview…" />;
  }

  if (error || !overview) {
    return <ErrorState error={error || 'Overview data is unavailable.'} />;
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(160px,1fr))]">
        <StatCard label="Active Projects" value={overview.stats.activeProjects} icon={FolderKanban} to="/projects" />
        <StatCard label="In Progress" value={overview.stats.inProgressAssignments} icon={Gauge} tone="info" to="/assignments?status=in_progress" />
        <StatCard label="Blocked" value={overview.stats.blockedAssignments} icon={AlertTriangle} tone="warn" to="/assignments?status=blocked" />
        <StatCard label="Review" value={overview.stats.reviewAssignments} icon={ClipboardCheck} tone="info" to="/assignments?status=review" />
        <StatCard label="Failed" value={overview.stats.failedAssignments} icon={OctagonX} tone="danger" to="/assignments?status=failed" />
        <StatCard label="Stale" value={overview.stats.staleAssignments} icon={Activity} to="/assignments?stale=1" />
        <StatCard label="Open Todos" value={openTodos} icon={CheckSquare} to="/todos" />
        <StatCard
          label="Active Servers"
          value={overview.serverStats ? overview.serverStats.aliveSessions : '…'}
          description={overview.serverStats ? `${overview.serverStats.totalPorts} ports · ${overview.serverStats.deadSessions > 0 ? `${overview.serverStats.deadSessions} dead` : 'all healthy'}` : 'connecting'}
          icon={Monitor}
          tone={overview.serverStats?.deadSessions ? 'warn' : 'default'}
          to="/servers"
        />
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
                        <p className="text-sm text-muted-foreground">{item.projectTitle}</p>
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
            <SectionCard title="Recently Updated Projects">
              {overview.recentProjects.length === 0 ? (
                <EmptyState
                  title="No projects yet"
                  description="Create your first project to populate the project directory, recent activity, and attention queue."
                  actions={
                    <Link className="shell-action bg-foreground text-background hover:opacity-90" to="/create/project">
                      Create Project
                    </Link>
                  }
                />
              ) : (
                <div className="space-y-3">
                  {overview.recentProjects.map((project) => (
                    <Link
                      key={project.slug}
                      to={`/projects/${project.slug}`}
                      className="block rounded-md border border-border/60 bg-background/80 p-3 transition hover:border-primary/40"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="font-semibold text-foreground">{project.title}</h3>
                          <p className="mt-1 text-sm text-muted-foreground">{formatDateTime(project.updated)}</p>
                        </div>
                        <StatusBadge status={project.status} />
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
                  description="Once projects and assignments exist, Overview will show activity based on parsed source timestamps instead of file mtimes."
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
                          {toTitleCase(item.type)}
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
