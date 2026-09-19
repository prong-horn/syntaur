import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArchiveRestore, ChevronDown, ChevronRight, FolderKanban, GitBranch, SquarePen } from 'lucide-react';
import { mutate } from '../../data/mutate';
import { apiUrl, projectWriteTargets } from '../../data/resources';
import type { ArchivedProjectItem, ProjectDetail, ProjectSummary } from '../../data/types';
import { LoadingState } from '../LoadingState';
import { ErrorState } from '../ErrorState';
import { EmptyState } from '../EmptyState';
import { SectionCard } from '../SectionCard';
import { StatusBadge } from '../StatusBadge';
import { ProgressBar } from '../ProgressBar';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { DependencyGraph } from '../DependencyGraph';
import { StatCard } from '../StatCard';
import { formatDateTime } from '../../lib/format';
import type { BoardFilterActions, BoardFilterState } from '../../hooks/useBoardFilters';

export interface BoardProjectPanelProps {
  state: BoardFilterState;
  actions: BoardFilterActions;
  projects: ProjectSummary[] | undefined;
  archived: ArchivedProjectItem[] | undefined;
  projectDetail: ProjectDetail | undefined;
  projectsLoading: boolean;
  archivedLoading: boolean;
  projectLoading: boolean;
  projectsError: string | null;
  onRefreshProjects: () => void;
  onRefreshArchived: () => void;
  onRefreshProject: () => void;
  showToast: (message: string, kind: 'success' | 'error') => void;
}

export function BoardProjectPanel({
  state,
  actions,
  projects,
  archived,
  projectDetail,
  projectsLoading,
  archivedLoading,
  projectLoading,
  projectsError,
  onRefreshProjects,
  onRefreshArchived,
  onRefreshProject: _onRefreshProject,
  showToast,
}: BoardProjectPanelProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [expandedArchived, setExpandedArchived] = useState<Record<string, boolean>>({});

  const focusSlug = state.project.length === 1 ? state.project[0] : null;
  const showProjectsList = state.panel === 'projects' || (!state.panel && !focusSlug);
  const showProjectDetail = state.panel === 'project' || (focusSlug && state.panel !== 'dependencies' && state.panel !== 'projects');
  const showDependencies = state.panel === 'dependencies';

  const visibleProjects = useMemo(() => {
    const active = projects ?? [];
    if (state.projectVisibility === 'archived') return [];
    return active;
  }, [projects, state.projectVisibility]);

  const archivedProjects = useMemo(() => {
    if (state.projectVisibility === 'active') return [];
    return archived ?? [];
  }, [archived, state.projectVisibility]);

  async function restoreProject(slug: string) {
    setBusy(slug);
    try {
      await mutate('POST', apiUrl(['projects', slug, 'unarchive']), undefined, {
        invalidates: projectWriteTargets(slug),
      });
      onRefreshArchived();
      onRefreshProjects();
      showToast('Project restored', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Restore failed', 'error');
    } finally {
      setBusy(null);
    }
  }

  if (showDependencies && focusSlug) {
    if (projectLoading) return <LoadingState label="Loading dependencies…" />;
    if (!projectDetail) {
      return (
        <SectionCard title="Unknown project">
          <p className="text-sm text-muted-foreground">
            Project <code>{focusSlug}</code> was not found or is archived. Its tickets are excluded from the active board feed.
          </p>
        </SectionCard>
      );
    }
    return projectDetail.dependencyGraph ? (
      <SectionCard title="Dependencies" description={`${projectDetail.title} dependency graph`}>
        <DependencyGraph
          definition={projectDetail.dependencyGraph}
          nodeRoutes={Object.fromEntries(
            projectDetail.tickets.flatMap((ticket) => [
              [ticket.slug, `/t/${ticket.id}`],
              [ticket.title, `/t/${ticket.id}`],
            ]),
          )}
        />
      </SectionCard>
    ) : (
      <EmptyState title="No dependency graph" description="Declare depends_on in tickets to build the graph." />
    );
  }

  if (showProjectDetail && focusSlug) {
    if (projectLoading) return <LoadingState label="Loading project…" />;
    if (!projectDetail) {
      return (
        <SectionCard title="Archived or unknown project">
          <p className="text-sm text-muted-foreground">
            <strong>{focusSlug}</strong> is not in the active project list. Tickets from archived projects are excluded from the kanban/table; open the archived panel to restore.
          </p>
          <button type="button" className="shell-action mt-3" onClick={() => actions.setProjectVisibility('archived')}>
            Show archived projects
          </button>
        </SectionCard>
      );
    }

    const archivedPayload = archived?.find((p) => p.slug === focusSlug);
    const readOnlyTickets = archivedPayload?.tickets ?? [];

    return (
      <div className="space-y-4">
        {projectDetail.archived || archivedPayload ? (
          <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
            This project is archived. Its tickets are excluded from the active board; shown read-only below.
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={projectDetail.status} />
          <button type="button" className="shell-action" onClick={() => actions.setDialog('edit-project')}>
            <SquarePen className="h-4 w-4" />
            <span>Edit</span>
          </button>
          <button type="button" className="shell-action" onClick={() => actions.setPanel('dependencies')}>
            <GitBranch className="h-4 w-4" />
            <span>Dependencies</span>
          </button>
          <button type="button" className="shell-action shell-action--cta" onClick={() => actions.setDialog('new-ticket')}>
            New ticket
          </button>
        </div>
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
          <StatCard label="Tickets" value={projectDetail.progress.total} />
          <StatCard label="Blocked" value={projectDetail.progress['blocked'] ?? 0} tone="warn" />
          <StatCard label="Review" value={projectDetail.progress['review'] ?? 0} tone="info" />
          <StatCard label="Done" value={projectDetail.progress['completed'] ?? 0} tone="success" />
        </div>
        <SectionCard title="Overview">
          {projectDetail.body?.trim() ? <MarkdownRenderer content={projectDetail.body} /> : (
            <EmptyState title="No overview" description="Edit the project to add context." />
          )}
        </SectionCard>
        {readOnlyTickets.length > 0 ? (
          <SectionCard title="Archived project tickets (read-only)">
            <ul className="space-y-2 text-sm">
              {readOnlyTickets.map((ticket) => (
                <li key={ticket.id} className="flex items-center gap-2">
                  <Link to={`/t/${ticket.id}`} className="text-foreground hover:underline">{ticket.title}</Link>
                  <StatusBadge status={ticket.status} showIcon={false} />
                </li>
              ))}
            </ul>
          </SectionCard>
        ) : null}
      </div>
    );
  }

  if (!showProjectsList) return null;

  if (projectsLoading && archivedLoading) return <LoadingState label="Loading projects…" />;
  if (projectsError) return <ErrorState error={projectsError} onRetry={onRefreshProjects} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={state.projectVisibility}
          onChange={(e) => actions.setProjectVisibility(e.target.value as BoardFilterState['projectVisibility'])}
          className="editor-input max-w-[200px]"
          aria-label="Project visibility"
        >
          <option value="active">Active projects</option>
          <option value="archived">Archived projects</option>
          <option value="all">All projects</option>
        </select>
        <button type="button" className="shell-action shell-action--cta" onClick={() => actions.setDialog('new-project')}>
          New project
        </button>
      </div>

      {visibleProjects.length > 0 ? (
        <SectionCard title="Projects">
          <ul className="divide-y divide-border">
            {visibleProjects.map((project) => (
              <li key={project.slug} className="flex flex-wrap items-center gap-3 py-3">
                <button
                  type="button"
                  className="inline-flex items-center gap-2 text-left font-medium hover:text-primary"
                  onClick={() => {
                    actions.setProjectFilter([project.slug]);
                    actions.setPanel('project');
                  }}
                >
                  <FolderKanban className="h-4 w-4 text-muted-foreground" />
                  {project.title}
                </button>
                <StatusBadge status={project.status} showIcon={false} />
                <span className="text-xs text-muted-foreground">{project.progress.total} tickets</span>
                <ProgressBar progress={project.progress} className="min-w-[120px] flex-1" />
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {archivedProjects.length > 0 ? (
        <SectionCard title="Archived projects" description="Restore to return tickets to the active board.">
          <ul className="divide-y divide-border">
            {archivedProjects.map((project) => {
              const open = expandedArchived[project.slug] ?? false;
              return (
                <li key={project.slug} className="py-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setExpandedArchived((prev) => ({ ...prev, [project.slug]: !open }))}
                      className="inline-flex items-center gap-1.5 text-sm font-medium"
                    >
                      {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      {project.title}
                      <span className="text-xs text-muted-foreground">
                        ({project.tickets.length} ticket{project.tickets.length === 1 ? '' : 's'})
                      </span>
                    </button>
                    <span className="text-xs text-muted-foreground">
                      Archived {project.archivedAt ? formatDateTime(project.archivedAt) : '—'}
                    </span>
                    <button
                      type="button"
                      disabled={busy === project.slug}
                      onClick={() => restoreProject(project.slug)}
                      className="ml-auto inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs"
                    >
                      <ArchiveRestore className="h-3 w-3" />
                      Restore
                    </button>
                  </div>
                  {open && project.tickets.length > 0 ? (
                    <ul className="mt-2 space-y-1 pl-8 text-sm">
                      {project.tickets.map((ticket) => (
                        <li key={ticket.id}>
                          <Link to={`/t/${ticket.id}`}>{ticket.title}</Link>
                          <span className="ml-2 text-xs text-muted-foreground">read-only until restore</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {open && project.tickets.length === 0 ? (
                    <p className="mt-2 pl-8 text-sm text-muted-foreground">No tickets — project can still be restored.</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </SectionCard>
      ) : null}

      {visibleProjects.length === 0 && archivedProjects.length === 0 ? (
        <EmptyState
          title="No projects"
          description="Create a project to organize tickets."
          actions={
            <button type="button" className="shell-action shell-action--cta" onClick={() => actions.setDialog('new-project')}>
              Create project
            </button>
          }
        />
      ) : null}
    </div>
  );
}
