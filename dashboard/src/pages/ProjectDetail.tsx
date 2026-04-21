import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { BookOpenText, GitBranch, Plus, SquarePen } from 'lucide-react';
import { CopyButton } from '../components/CopyButton';
import { useProject, useWorkspaces, useWorkspacePrefix, type AssignmentSummary } from '../hooks/useProjects';
import { formatDate, formatDateTime } from '../lib/format';
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
import { useStatusConfig } from '../hooks/useStatusConfig';
import { useHotkey, useHotkeyScope } from '../hotkeys';

export function ProjectDetail() {
  const { slug } = useParams<{ slug: string }>();
  const wsPrefix = useWorkspacePrefix();
  const navigate = useNavigate();
  useHotkeyScope('project');
  useHotkey({
    keys: 'a',
    scope: 'project',
    description: 'Create assignment',
    handler: () => navigate(`${wsPrefix}/projects/${slug}/create/assignment`),
  });
  useHotkey({
    keys: 'e',
    scope: 'project',
    description: 'Edit project',
    handler: () => navigate(`${wsPrefix}/projects/${slug}/edit`),
  });
  const { data: project, loading, error, refetch } = useProject(slug);
  const statusConfig = useStatusConfig();
  const { data: workspacesData } = useWorkspaces();
  const [tab, setTab] = useState('overview');
  const [assignmentView, setAssignmentView] = useState<'board' | 'table'>('board');
  const [statusFilter, setStatusFilter] = useState('all');
  const [assigneeFilter, setAssigneeFilter] = useState('all');
  const [priorityFilter, setPriorityFilter] = useState('all');

  const dependencyRoutes = useMemo(
    () => project ? Object.fromEntries(
      project.assignments.flatMap((assignment) => {
        const route = `${wsPrefix}/projects/${project.slug}/assignments/${assignment.slug}`;
        return [
          [assignment.slug, route],
          [assignment.title, route],
        ];
      }),
    ) : {},
    [project],
  );

  async function handleStatusOverride(status: string | null) {
    await fetch(`/api/projects/${slug}/status-override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    refetch();
  }

  async function handleMoveWorkspace(workspace: string | null) {
    await fetch(`/api/projects/${slug}/move-workspace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace }),
    });
    refetch();
  }

  if (loading) {
    return <LoadingState label="Loading project workspace…" />;
  }

  if (error || !project) {
    return <ErrorState error={error || 'Project not found.'} />;
  }

  const assignees = Array.from(
    new Set(project.assignments.map((assignment) => assignment.assignee).filter(Boolean)),
  ).sort();
  const filteredAssignments = project.assignments.filter((assignment) => {
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
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge status={project.status} />
        {project.statusOverride && (
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
          title="Override project status"
        >
          <option value="">Set Status…</option>
          {statusConfig.statuses.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
          <option value="active">Active</option>
        </select>
        {workspacesData && workspacesData.workspaces.length > 0 && (
          <select
            className="shell-action appearance-none bg-transparent text-sm"
            value=""
            onChange={(e) => {
              if (e.target.value === '_ungrouped') handleMoveWorkspace(null);
              else if (e.target.value) handleMoveWorkspace(e.target.value);
            }}
            title="Move project to a different workspace"
          >
            <option value="">Move to Workspace…</option>
            {workspacesData.workspaces
              .filter((w) => w !== project.workspace)
              .map((w) => (
                <option key={w} value={w}>{w}</option>
              ))}
            {project.workspace && <option value="_ungrouped">Ungrouped</option>}
          </select>
        )}
        <Link className="shell-action" to={`${wsPrefix}/projects/${project.slug}/edit`}>
          <SquarePen className="h-4 w-4" />
          <span>Edit Project</span>
        </Link>
        <Link className="shell-action bg-foreground text-background hover:opacity-90" to={`${wsPrefix}/projects/${project.slug}/create/assignment`}>
          <Plus className="h-4 w-4" />
          <span>New Assignment</span>
        </Link>
        <span className="text-xs text-muted-foreground">Created {formatDate(project.created)}. Last source update {formatDateTime(project.updated)}.</span>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Assignments" value={project.progress.total} />
        <StatCard label="In Progress" value={project.progress['in_progress'] ?? 0} tone="info" />
        <StatCard label="Review" value={project.progress['review'] ?? 0} tone="info" />
        <StatCard label="Blocked" value={project.progress['blocked'] ?? 0} tone="warn" />
        <StatCard label="Completed" value={project.progress['completed'] ?? 0} tone="success" />
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
                    <SectionCard title="Project Overview">
                      <MarkdownRenderer
                        content={project.body}
                        emptyState="This project does not have overview content yet."
                      />
                    </SectionCard>
                  </div>
                ),
              },
              {
                value: 'assignments',
                label: 'Assignments',
                count: project.assignments.length,
                content: (
                  <div className="space-y-5">
                    <SectionCard
                      title="Assignment Queue"
                      description="Board and table views over the source assignment files."
                      actions={
                        <div className="flex flex-wrap items-center gap-2">
                          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="editor-input max-w-[170px]">
                            <option value="all">All statuses</option>
                            {statusConfig.statuses.map((s) => (
                              <option key={s.id} value={s.id}>{s.label}</option>
                            ))}
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
                          description="Clear the current filters or create a new assignment for this project."
                          actions={
                            <Link className="shell-action bg-foreground text-background hover:opacity-90" to={`${wsPrefix}/projects/${project.slug}/create/assignment`}>
                              Create Assignment
                            </Link>
                          }
                        />
                      ) : assignmentView === 'board' ? (
                        <div className="grid gap-3 lg:grid-cols-2">
                          {filteredAssignments.map((assignment) => (
                            <AssignmentCard key={assignment.slug} projectSlug={project.slug} assignment={assignment} />
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
                                      to={`${wsPrefix}/projects/${project.slug}/assignments/${assignment.slug}`}
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
                content: project.dependencyGraph ? (
                  <SectionCard
                    title="Dependency Graph"
                    description="Rendered from the derived graph when available, with a source-based fallback."
                  >
                    <DependencyGraph definition={project.dependencyGraph} nodeRoutes={dependencyRoutes} />
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
                    <SectionCard title="Resources" description="Shared project references.">
                      {project.resources.length === 0 ? (
                        <EmptyState
                          title="No resources yet"
                          description="Resources live at the project level and stay available to every assignment."
                        />
                      ) : (
                        <div className="space-y-3">
                          {project.resources.map((resource) => (
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

                    <SectionCard title="Memories" description="Learnings and patterns captured during the project.">
                      {project.memories.length === 0 ? (
                        <EmptyState
                          title="No memories yet"
                          description="Memories capture patterns discovered during execution so later assignments can reuse them."
                        />
                      ) : (
                        <div className="space-y-3">
                          {project.memories.map((memory) => (
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
            <ProgressBar progress={project.progress} showLegend />
          </SectionCard>

          <SectionCard title="Attention">
            <dl className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Blocked</dt>
                <dd className="font-semibold text-foreground">{project.needsAttention.blockedCount}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Failed</dt>
                <dd className="font-semibold text-foreground">{project.needsAttention.failedCount}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Unanswered questions</dt>
                <dd className="font-semibold text-foreground">{project.needsAttention.unansweredQuestions}</dd>
              </div>
            </dl>
          </SectionCard>

          <SectionCard title="Quick Links">
            <div className="space-y-2 text-sm">
              <Link className="flex items-center gap-2 text-primary hover:underline" to={`${wsPrefix}/projects/${project.slug}/edit`}>
                <SquarePen className="h-4 w-4" />
                Edit project source
              </Link>
              <Link className="flex items-center gap-2 text-primary hover:underline" to={`${wsPrefix}/projects/${project.slug}/create/assignment`}>
                <Plus className="h-4 w-4" />
                Create assignment
              </Link>
              <Link className="flex items-center gap-2 text-primary hover:underline" to="/help">
                <BookOpenText className="h-4 w-4" />
                Review project rules
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

          {project.archived ? (
            <SectionCard title="Archive Metadata">
              <p className="text-sm leading-6 text-muted-foreground">
                Archived {project.archivedAt ? formatDateTime(project.archivedAt) : 'with no timestamp recorded'}.
              </p>
              {project.archivedReason ? (
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{project.archivedReason}</p>
              ) : null}
            </SectionCard>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AssignmentCard({
  projectSlug,
  assignment,
}: {
  projectSlug: string;
  assignment: AssignmentSummary;
}) {
  const wsPrefix = useWorkspacePrefix();
  return (
    <Link
      to={`${wsPrefix}/projects/${projectSlug}/assignments/${assignment.slug}`}
      className="block rounded-lg border border-border/60 bg-background/80 p-3 transition hover:border-primary/40"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="font-semibold text-foreground">{assignment.title}</h3>
          <p className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground/70" title={assignment.id}>
            {assignment.id.slice(0, 8)}
            <span onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
              <CopyButton value={assignment.id} />
            </span>
          </p>
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
