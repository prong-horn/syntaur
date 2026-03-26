import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BookOpenText, GitBranch, Plus, SquarePen } from 'lucide-react';
import { useMission, type AssignmentSummary } from '../hooks/useMissions';
import { formatDate, formatDateTime } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { StatusBadge } from '../components/StatusBadge';
import { StatCard } from '../components/StatCard';
import { ProgressBar } from '../components/ProgressBar';
import { ContentTabs } from '../components/ContentTabs';
import { SectionCard } from '../components/SectionCard';
import { ViewToggle } from '../components/ViewToggle';
import { EmptyState } from '../components/EmptyState';
import { DependencyGraph } from '../components/DependencyGraph';
import { MarkdownRenderer } from '../components/MarkdownRenderer';

export function MissionDetail() {
  const { slug } = useParams<{ slug: string }>();
  const { data: mission, loading, error, refetch } = useMission(slug);
  const [tab, setTab] = useState('overview');
  const [assignmentView, setAssignmentView] = useState<'board' | 'table'>('board');
  const [statusFilter, setStatusFilter] = useState('all');
  const [assigneeFilter, setAssigneeFilter] = useState('all');
  const [priorityFilter, setPriorityFilter] = useState('all');

  async function handleStatusOverride(status: string | null) {
    await fetch(`/api/missions/${slug}/status-override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    refetch();
  }

  if (loading) {
    return <LoadingState label="Loading mission workspace…" />;
  }

  if (error || !mission) {
    return <ErrorState error={error || 'Mission not found.'} />;
  }

  const assignees = Array.from(
    new Set(mission.assignments.map((assignment) => assignment.assignee).filter(Boolean)),
  ).sort();
  const filteredAssignments = mission.assignments.filter((assignment) => {
    if (statusFilter !== 'all' && assignment.status !== statusFilter) {
      return false;
    }
    if (assigneeFilter !== 'all' && assignment.assignee !== assigneeFilter) {
      return false;
    }
    if (priorityFilter !== 'all' && assignment.priority !== priorityFilter) {
      return false;
    }
    return true;
  });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Mission Workspace"
        title={mission.title}
        description={`Created ${formatDate(mission.created)}. Last source update ${formatDateTime(mission.updated)}.`}
        actions={
          <>
            <StatusBadge status={mission.status} />
            {mission.statusOverride && (
              <button
                type="button"
                className="shell-action border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-300"
                onClick={() => handleStatusOverride(null)}
                title="Clear manual status override and return to derived status"
              >
                Clear Override
              </button>
            )}
            <select
              className="shell-action appearance-none bg-transparent text-sm"
              value=""
              onChange={(e) => {
                if (e.target.value) handleStatusOverride(e.target.value);
              }}
              title="Override mission status"
            >
              <option value="">Set Status…</option>
              <option value="pending">Pending</option>
              <option value="active">Active</option>
              <option value="blocked">Blocked</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
            </select>
            <Link className="shell-action" to={`/missions/${mission.slug}/edit`}>
              <SquarePen className="h-4 w-4" />
              <span>Edit Mission</span>
            </Link>
            <Link className="shell-action bg-foreground text-background hover:opacity-90" to={`/missions/${mission.slug}/create/assignment`}>
              <Plus className="h-4 w-4" />
              <span>New Assignment</span>
            </Link>
          </>
        }
      />

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Assignments" value={mission.progress.total} />
        <StatCard label="In Progress" value={mission.progress.in_progress} tone="info" />
        <StatCard label="Blocked" value={mission.progress.blocked} tone="warn" />
        <StatCard label="Completed" value={mission.progress.completed} tone="success" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
        <div className="space-y-4">
          <ContentTabs
            value={tab}
            onValueChange={setTab}
            items={[
              {
                value: 'overview',
                label: 'Overview',
                content: (
                  <div className="space-y-5">
                    <SectionCard title="Mission Overview">
                      <MarkdownRenderer
                        content={mission.body}
                        emptyState="This mission does not have overview content yet."
                      />
                    </SectionCard>
                  </div>
                ),
              },
              {
                value: 'assignments',
                label: 'Assignments',
                count: mission.assignments.length,
                content: (
                  <div className="space-y-5">
                    <SectionCard
                      title="Assignment Queue"
                      description="Board and table views over the source assignment files."
                      actions={
                        <div className="flex flex-wrap items-center gap-2">
                          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="editor-input max-w-[170px]">
                            <option value="all">All statuses</option>
                            <option value="pending">Pending</option>
                            <option value="in_progress">In progress</option>
                            <option value="blocked">Blocked</option>
                            <option value="review">Review</option>
                            <option value="completed">Completed</option>
                            <option value="failed">Failed</option>
                          </select>
                          <select value={assigneeFilter} onChange={(event) => setAssigneeFilter(event.target.value)} className="editor-input max-w-[170px]">
                            <option value="all">All assignees</option>
                            {assignees.map((assignee) => (
                              <option key={assignee} value={assignee ?? ''}>
                                {assignee}
                              </option>
                            ))}
                          </select>
                          <select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)} className="editor-input max-w-[170px]">
                            <option value="all">All priorities</option>
                            <option value="low">Low</option>
                            <option value="medium">Medium</option>
                            <option value="high">High</option>
                            <option value="critical">Critical</option>
                          </select>
                          <ViewToggle
                            value={assignmentView}
                            onChange={(value) => setAssignmentView(value as 'board' | 'table')}
                            options={[
                              { value: 'board', label: 'Board' },
                              { value: 'table', label: 'Table' },
                            ]}
                          />
                        </div>
                      }
                    >
                      {filteredAssignments.length === 0 ? (
                        <EmptyState
                          title="No assignments match these filters"
                          description="Clear the current filters or create a new assignment for this mission."
                          actions={
                            <Link className="shell-action bg-foreground text-background hover:opacity-90" to={`/missions/${mission.slug}/create/assignment`}>
                              Create Assignment
                            </Link>
                          }
                        />
                      ) : assignmentView === 'board' ? (
                        <div className="grid gap-3 lg:grid-cols-2">
                          {filteredAssignments.map((assignment) => (
                            <AssignmentCard key={assignment.slug} missionSlug={mission.slug} assignment={assignment} />
                          ))}
                        </div>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full min-w-[720px] text-left text-sm">
                            <thead>
                              <tr className="border-b border-border/60 text-muted-foreground">
                                <th className="pb-3 font-medium">Assignment</th>
                                <th className="pb-3 font-medium">Status</th>
                                <th className="pb-3 font-medium">Priority</th>
                                <th className="pb-3 font-medium">Assignee</th>
                                <th className="pb-3 font-medium">Updated</th>
                              </tr>
                            </thead>
                            <tbody>
                              {filteredAssignments.map((assignment) => (
                                <tr key={assignment.slug} className="border-b border-border/50 last:border-0">
                                  <td className="py-4">
                                    <Link
                                      to={`/missions/${mission.slug}/assignments/${assignment.slug}`}
                                      className="font-semibold text-foreground hover:text-primary"
                                    >
                                      {assignment.title}
                                    </Link>
                                  </td>
                                  <td className="py-4"><StatusBadge status={assignment.status} /></td>
                                  <td className="py-4 capitalize text-muted-foreground">{assignment.priority}</td>
                                  <td className="py-4 text-muted-foreground">{assignment.assignee ?? '\u2014'}</td>
                                  <td className="py-4 text-muted-foreground">{formatDate(assignment.updated)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </SectionCard>
                  </div>
                ),
              },
              {
                value: 'dependencies',
                label: 'Dependencies',
                content: mission.dependencyGraph ? (
                  <SectionCard
                    title="Dependency Graph"
                    description="Rendered from the derived graph when available, with a source-based fallback."
                  >
                    <DependencyGraph definition={mission.dependencyGraph} />
                  </SectionCard>
                ) : (
                  <EmptyState
                    title="No dependency graph yet"
                    description="Dependencies appear here once assignments declare dependsOn relationships."
                  />
                ),
              },
              {
                value: 'knowledge',
                label: 'Knowledge',
                content: (
                  <div className="grid gap-3 lg:grid-cols-2">
                    <SectionCard title="Resources" description="Shared mission references.">
                      {mission.resources.length === 0 ? (
                        <EmptyState
                          title="No resources yet"
                          description="Resources live at the mission level and stay available to every assignment."
                        />
                      ) : (
                        <div className="space-y-3">
                          {mission.resources.map((resource) => (
                            <div key={resource.slug} className="rounded-md border border-border/60 bg-background/80 p-3">
                              <h3 className="font-semibold text-foreground">{resource.name}</h3>
                              <p className="mt-2 text-sm text-muted-foreground">
                                {resource.category} · {resource.source}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                    </SectionCard>

                    <SectionCard title="Memories" description="Learnings and patterns captured during the mission.">
                      {mission.memories.length === 0 ? (
                        <EmptyState
                          title="No memories yet"
                          description="Memories capture patterns discovered during execution so later assignments can reuse them."
                        />
                      ) : (
                        <div className="space-y-3">
                          {mission.memories.map((memory) => (
                            <div key={memory.slug} className="rounded-md border border-border/60 bg-background/80 p-3">
                              <h3 className="font-semibold text-foreground">{memory.name}</h3>
                              <p className="mt-2 text-sm text-muted-foreground">
                                {memory.scope} · {memory.source}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                    </SectionCard>
                  </div>
                ),
              },
            ]}
          />
        </div>

        <div className="space-y-5">
          <SectionCard title="Progress Summary">
            <ProgressBar progress={mission.progress} showLegend />
          </SectionCard>

          <SectionCard title="Attention">
            <dl className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Blocked</dt>
                <dd className="font-semibold text-foreground">{mission.needsAttention.blockedCount}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Failed</dt>
                <dd className="font-semibold text-foreground">{mission.needsAttention.failedCount}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Unanswered questions</dt>
                <dd className="font-semibold text-foreground">{mission.needsAttention.unansweredQuestions}</dd>
              </div>
            </dl>
          </SectionCard>

          <SectionCard title="Quick Links">
            <div className="space-y-2 text-sm">
              <Link className="flex items-center gap-2 text-primary hover:underline" to={`/missions/${mission.slug}/edit`}>
                <SquarePen className="h-4 w-4" />
                Edit mission source
              </Link>
              <Link className="flex items-center gap-2 text-primary hover:underline" to={`/missions/${mission.slug}/create/assignment`}>
                <Plus className="h-4 w-4" />
                Create assignment
              </Link>
              <Link className="flex items-center gap-2 text-primary hover:underline" to="/help">
                <BookOpenText className="h-4 w-4" />
                Review mission rules
              </Link>
              <button
                type="button"
                onClick={() => setTab('dependencies')}
                className="flex items-center gap-2 text-primary hover:underline"
              >
                <GitBranch className="h-4 w-4" />
                Jump to dependencies
              </button>
            </div>
          </SectionCard>

          {mission.archived ? (
            <SectionCard title="Archive Metadata">
              <p className="text-sm leading-6 text-muted-foreground">
                Archived {mission.archivedAt ? formatDateTime(mission.archivedAt) : 'with no timestamp recorded'}.
              </p>
              {mission.archivedReason ? (
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{mission.archivedReason}</p>
              ) : null}
            </SectionCard>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AssignmentCard({
  missionSlug,
  assignment,
}: {
  missionSlug: string;
  assignment: AssignmentSummary;
}) {
  return (
    <Link
      to={`/missions/${missionSlug}/assignments/${assignment.slug}`}
      className="block rounded-lg border border-border/60 bg-background/80 p-3 transition hover:border-primary/40"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="font-semibold text-foreground">{assignment.title}</h3>
          <p className="font-mono text-xs text-muted-foreground/70" title={assignment.id}>{assignment.id.slice(0, 8)}</p>
          <p className="text-sm text-muted-foreground">Updated {formatDate(assignment.updated)}</p>
        </div>
        <StatusBadge status={assignment.status} />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <span className="rounded-full border border-border/60 px-2.5 py-1 text-xs capitalize text-muted-foreground">
          {assignment.priority}
        </span>
        <span className="rounded-full border border-border/60 px-2.5 py-1 text-xs text-muted-foreground">
          {assignment.assignee ?? 'Unassigned'}
        </span>
        <span className="rounded-full border border-border/60 px-2.5 py-1 text-xs text-muted-foreground">
          {assignment.dependsOn.length} dependencies
        </span>
      </div>
    </Link>
  );
}
