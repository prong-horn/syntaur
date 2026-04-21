import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams, useParams } from 'react-router-dom';
import { Info } from 'lucide-react';
import { useProjects, useWorkspacePrefix, type ProjectSummary } from '../hooks/useProjects';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { FilterBar } from '../components/FilterBar';
import { SearchInput } from '../components/SearchInput';
import { ViewToggle } from '../components/ViewToggle';
import { SectionCard } from '../components/SectionCard';
import { KanbanBoard, type KanbanColumn } from '../components/KanbanBoard';
import { StatusBadge, getStatusDescription } from '../components/StatusBadge';
import { ProgressBar } from '../components/ProgressBar';
import { formatDate } from '../lib/format';
import { PROJECT_BOARD_COLUMNS, moveItem } from '../lib/kanban';
import { useHotkey, useHotkeyScope, useListSelection } from '../hotkeys';

export function ProjectList() {
  const { workspace } = useParams<{ workspace?: string }>();
  const wsPrefix = useWorkspacePrefix();
  const navigate = useNavigate();
  const { data: projects, loading, error, refetch } = useProjects();
  const searchRef = useRef<HTMLInputElement>(null);
  useHotkeyScope('list:projects');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [archivedFilter, setArchivedFilter] = useState('active');
  const [tagFilter, setTagFilter] = useState('all');
  const [sortBy, setSortBy] = useState('updated');
  const [searchParams, setSearchParams] = useSearchParams();
  const viewParam = searchParams.get('view');
  const view: 'cards' | 'table' | 'kanban' =
    viewParam === 'table' || viewParam === 'kanban' ? viewParam : 'cards';
  const setView = (v: 'cards' | 'table' | 'kanban') => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (v === 'cards') {
        next.delete('view');
      } else {
        next.set('view', v);
      }
      return next;
    });
  };
  const [projectOrder, setProjectOrder] = useState<Record<string, string[]>>({});

  const filtered = useMemo(() => {
    if (!projects) {
      return [];
    }
    return projects
      .filter((project) => {
        if (workspace) {
          if (workspace === '_ungrouped') {
            if (project.workspace !== null) return false;
          } else {
            if (project.workspace !== workspace) return false;
          }
        }
        if (archivedFilter === 'active' && project.archived) {
          return false;
        }
        if (archivedFilter === 'archived' && !project.archived) {
          return false;
        }
        if (statusFilter !== 'all' && project.status !== statusFilter) {
          return false;
        }
        if (tagFilter !== 'all' && !project.tags.includes(tagFilter)) {
          return false;
        }
        if (!search.trim()) {
          return true;
        }

        const haystack = `${project.title} ${project.tags.join(' ')} ${project.slug}`.toLowerCase();
        return haystack.includes(search.toLowerCase());
      })
      .sort((left, right) => sortProjects(left, right, sortBy));
  }, [projects, search, statusFilter, archivedFilter, tagFilter, sortBy, workspace]);

  const filteredKey = filtered.map((project) => `${project.slug}:${project.status}`).join('|');

  useEffect(() => {
    setProjectOrder(buildProjectColumnOrder(filtered));
  }, [filteredKey, sortBy]);

  const orderedBoardProjects = useMemo(() => {
    const bySlug = new Map(filtered.map((project) => [project.slug, project]));

    return PROJECT_BOARD_COLUMNS.flatMap((status) => {
      const orderedSlugs = projectOrder[status] ?? filtered
        .filter((project) => project.status === status)
        .map((project) => project.slug);

      return orderedSlugs
        .map((slug) => bySlug.get(slug))
        .filter((project): project is ProjectSummary => Boolean(project));
    });
  }, [filtered, projectOrder]);

  // Flat visible order: kanban traverses columns top-to-bottom, cards/table use `filtered`.
  const { visibleItems, visibleIndexByKey } = useMemo(() => {
    const items = view === 'kanban' ? orderedBoardProjects : filtered;
    const byKey = new Map<string, number>();
    items.forEach((m, i) => byKey.set(m.slug, i));
    return { visibleItems: items, visibleIndexByKey: byKey };
  }, [view, filtered, orderedBoardProjects]);

  const { hotkeyRowProps } = useListSelection(visibleItems, {
    scope: 'list:projects',
    onOpen: (project) => navigate(`${wsPrefix}/projects/${project.slug}`),
  });
  useHotkey({
    keys: '/',
    scope: 'list:projects',
    description: 'Focus filter',
    handler: () => searchRef.current?.focus(),
  });
  useHotkey({
    keys: 'r',
    scope: 'list:projects',
    description: 'Refresh',
    handler: () => refetch(),
  });

  if (loading) {
    return <LoadingState label="Loading projects…" />;
  }

  if (error || !projects) {
    return <ErrorState error={error || 'Project list is unavailable.'} />;
  }

  const tags = Array.from(new Set(projects.flatMap((project) => project.tags))).sort();

  return (
    <div className="space-y-5">
      <FilterBar>
        <SearchInput
          ref={searchRef}
          value={search}
          onChange={setSearch}
          placeholder="Search by project title or tag"
        />
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="editor-input max-w-[180px]">
          <option value="all">All statuses</option>
          <option value="pending">Pending</option>
          <option value="active">Active</option>
          <option value="blocked">Blocked</option>
          <option value="failed">Failed</option>
          <option value="completed">Completed</option>
          <option value="archived">Archived</option>
        </select>
        <select value={archivedFilter} onChange={(event) => setArchivedFilter(event.target.value)} className="editor-input max-w-[180px]">
          <option value="active">Hide archived</option>
          <option value="all">All projects</option>
          <option value="archived">Archived only</option>
        </select>
        <select value={tagFilter} onChange={(event) => setTagFilter(event.target.value)} className="editor-input max-w-[180px]">
          <option value="all">All tags</option>
          {tags.map((tag) => (
            <option key={tag} value={tag}>
              {tag}
            </option>
          ))}
        </select>
        <select value={sortBy} onChange={(event) => setSortBy(event.target.value)} className="editor-input max-w-[180px]">
          <option value="updated">Sort: Updated</option>
          <option value="created">Sort: Created</option>
          <option value="title">Sort: Title</option>
          <option value="attention">Sort: Attention</option>
        </select>
        <ViewToggle
          value={view}
          onChange={(value) => setView(value as 'cards' | 'table' | 'kanban')}
          options={[
            { value: 'cards', label: 'Cards' },
            { value: 'table', label: 'Table' },
            { value: 'kanban', label: 'Kanban' },
          ]}
        />
      </FilterBar>

      {filtered.length === 0 ? (
        <EmptyState
          title={projects.length === 0 ? 'No projects yet' : 'No projects match these filters'}
          description={
            projects.length === 0
              ? 'A project is the high-level objective that groups assignments, resources, and memories. Create one to start the dashboard flow.'
              : 'Adjust the current search and filters or create a new project.'
          }
          actions={
            <Link className="shell-action bg-foreground text-background hover:opacity-90" to={`${wsPrefix}/create/project`}>
              Create Project
            </Link>
          }
        />
      ) : view === 'cards' ? (
        <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {filtered.map((project, i) => (
            <Link
              key={project.slug}
              to={`${wsPrefix}/projects/${project.slug}`}
              className="block rounded-lg border border-border/60 bg-card/90 p-3 shadow-sm transition hover:border-primary/40 hover:shadow-md"
              {...hotkeyRowProps(i)}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <h2 className="text-lg font-semibold text-foreground">{project.title}</h2>
                  <p className="text-sm text-muted-foreground">
                    Updated {formatDate(project.updated)}
                  </p>
                </div>
                <StatusBadge status={project.status} />
              </div>

              <div className="mt-4 space-y-3">
                <ProgressBar progress={project.progress} showLegend />
                <div className="flex flex-wrap gap-2">
                  {project.tags.map((tag) => (
                    <span key={tag} className="rounded-full border border-border/60 bg-background/80 px-2.5 py-1 text-xs text-foreground">
                      {tag}
                    </span>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-md border border-border/60 bg-background/80 p-3">
                    <p className="text-muted-foreground">Needs attention</p>
                    <p className="mt-1 font-semibold text-foreground">
                      {project.needsAttention.blockedCount + project.needsAttention.failedCount}
                    </p>
                  </div>
                  <div className="rounded-md border border-border/60 bg-background/80 p-3">
                    <p className="text-muted-foreground">Assignments</p>
                    <p className="mt-1 font-semibold text-foreground">{project.progress.total}</p>
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      ) : view === 'table' ? (
        <SectionCard title={`${filtered.length} project${filtered.length === 1 ? '' : 's'}`}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-border/60 text-muted-foreground">
                  <th className="pb-3 font-medium">Project</th>
                  <th className="pb-3 font-medium">Status</th>
                  <th className="pb-3 font-medium">Progress</th>
                  <th className="pb-3 font-medium">Attention</th>
                  <th className="pb-3 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((project, i) => (
                  <tr
                    key={project.slug}
                    className="border-b border-border/50 last:border-0"
                    {...hotkeyRowProps(i)}
                  >
                    <td className="py-4 pr-4">
                      <Link to={`${wsPrefix}/projects/${project.slug}`} className="font-semibold text-foreground hover:text-primary">
                        {project.title}
                      </Link>
                      <div className="mt-1 flex flex-wrap gap-2">
                        {project.tags.map((tag) => (
                          <span key={tag} className="rounded-full border border-border/60 px-2 py-0.5 text-xs text-muted-foreground">
                            {tag}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="py-4 pr-4">
                      <StatusBadge status={project.status} />
                    </td>
                    <td className="py-4 pr-4">
                      <div className="min-w-[220px]">
                        <ProgressBar progress={project.progress} />
                      </div>
                    </td>
                    <td className="py-4 pr-4 text-muted-foreground">
                      {project.needsAttention.blockedCount + project.needsAttention.failedCount}
                    </td>
                    <td className="py-4 text-muted-foreground">{formatDate(project.updated)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      ) : (
        <KanbanBoard
          columns={PROJECT_COLUMNS}
          items={orderedBoardProjects}
          getItemId={(project) => project.slug}
          getColumnId={(project) => project.status}
          canDrop={({ fromColumnId, toColumnId }) => ({
            allowed: true,
            reason:
              fromColumnId === toColumnId
                ? undefined
                : 'This will set a manual status override on the project.',
          })}
          onMove={({ item, fromColumnId, toColumnId, fromIndex, toIndex }) => {
            if (fromColumnId === toColumnId) {
              const currentColumnOrder = projectOrder[fromColumnId] ?? filtered
                .filter((project) => project.status === fromColumnId)
                .map((project) => project.slug);

              setProjectOrder((current) => ({
                ...current,
                [fromColumnId]: moveItem(currentColumnOrder, fromIndex, toIndex),
              }));
              return;
            }

            fetch(`/api/projects/${item.slug}/status-override`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: toColumnId }),
            }).then(() => {
              window.location.reload();
            });
          }}
          emptyMessage={(column) => `No ${column.title.toLowerCase()} projects.`}
          renderCard={(project, { dragging }) => {
            const flatIdx = visibleIndexByKey.get(project.slug) ?? -1;
            return (
              <div {...(flatIdx >= 0 ? hotkeyRowProps(flatIdx) : {})}>
                <ProjectBoardCard project={project} dragging={dragging} />
              </div>
            );
          }}
        />
      )}

      <div className="rounded-lg border border-border/60 bg-card/80 p-3 text-sm text-muted-foreground">
        <div className="flex items-start gap-3">
          <Info className="mt-0.5 h-4 w-4" />
          <p>
            Project status is derived from assignment state by default.{view === 'kanban' ? ' Drag projects between columns or use' : ' Use'} the status override on the project detail page to set a manual status.
          </p>
        </div>
      </div>
    </div>
  );
}

const PROJECT_COLUMN_LABELS: Record<(typeof PROJECT_BOARD_COLUMNS)[number], string> = {
  pending: 'Pending',
  active: 'Active',
  blocked: 'Blocked',
  failed: 'Failed',
  completed: 'Completed',
  archived: 'Archived',
};

const PROJECT_COLUMNS: KanbanColumn[] = PROJECT_BOARD_COLUMNS.map((status) => ({
  id: status,
  title: PROJECT_COLUMN_LABELS[status],
  description: getStatusDescription(status),
}));

function sortProjects(left: ProjectSummary, right: ProjectSummary, sortBy: string): number {
  switch (sortBy) {
    case 'created':
      return right.created.localeCompare(left.created);
    case 'title':
      return left.title.localeCompare(right.title);
    case 'attention':
      return getAttentionScore(right) - getAttentionScore(left);
    case 'updated':
    default:
      return right.updated.localeCompare(left.updated);
  }
}

function getAttentionScore(project: ProjectSummary): number {
  return (
    project.needsAttention.failedCount * 10 +
    project.needsAttention.blockedCount * 5 +
    project.needsAttention.openQuestions
  );
}

function buildProjectColumnOrder(projects: ProjectSummary[]): Record<string, string[]> {
  return Object.fromEntries(
    PROJECT_BOARD_COLUMNS.map((status) => [
      status,
      projects
        .filter((project) => project.status === status)
        .map((project) => project.slug),
    ]),
  );
}

function ProjectBoardCard({
  project,
  dragging,
}: {
  project: ProjectSummary;
  dragging: boolean;
}) {
  const wsPrefix = useWorkspacePrefix();
  return (
    <div className="rounded-lg border border-border/60 bg-background/85 p-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <Link to={`${wsPrefix}/projects/${project.slug}`} className="text-base font-semibold text-foreground hover:text-primary">
            {project.title}
          </Link>
          <p className="text-sm text-muted-foreground">Updated {formatDate(project.updated)}</p>
        </div>
        <StatusBadge status={project.status} />
      </div>

      <div className="mt-4">
        <ProgressBar progress={project.progress} />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {project.tags.map((tag) => (
          <span key={tag} className="rounded-full border border-border/60 bg-background/80 px-2.5 py-1 text-xs text-foreground">
            {tag}
          </span>
        ))}
        <span className="rounded-full border border-border/60 px-2.5 py-1 text-xs text-muted-foreground">
          {project.progress.total} assignments
        </span>
        <span className="rounded-full border border-border/60 px-2.5 py-1 text-xs text-muted-foreground">
          {project.needsAttention.blockedCount + project.needsAttention.failedCount} needs attention
        </span>
      </div>

      <div className="mt-4 text-xs uppercase tracking-[0.08em] text-muted-foreground">
        {dragging ? 'Reordering within status' : 'Derived project lane'}
      </div>
    </div>
  );
}
