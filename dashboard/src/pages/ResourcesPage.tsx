import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import { useResources } from '../hooks/useProjects';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { formatDate } from '../lib/format';

export function ResourcesPage() {
  const { data, loading, error } = useResources();
  const [search, setSearch] = useState('');
  const [projectFilter, setProjectFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');

  const resources = data?.resources ?? [];

  const projects = useMemo(
    () => Array.from(new Set(resources.map((r) => r.projectSlug))).sort(),
    [resources],
  );
  const categories = useMemo(
    () => Array.from(new Set(resources.map((r) => r.category).filter(Boolean))).sort(),
    [resources],
  );
  const sources = useMemo(
    () => Array.from(new Set(resources.map((r) => r.source).filter(Boolean))).sort(),
    [resources],
  );

  const filtered = useMemo(() => {
    return resources.filter((r) => {
      if (projectFilter !== 'all' && r.projectSlug !== projectFilter) return false;
      if (categoryFilter !== 'all' && r.category !== categoryFilter) return false;
      if (sourceFilter !== 'all' && r.source !== sourceFilter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        if (
          !r.name.toLowerCase().includes(q) &&
          !r.slug.toLowerCase().includes(q) &&
          !r.projectTitle.toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [resources, search, projectFilter, categoryFilter, sourceFilter]);

  if (loading) return <LoadingState label="Loading resources…" />;
  if (error) return <ErrorState error={error} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search resources…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 w-64 rounded-md border border-border/70 bg-background pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-foreground/30 focus:outline-none"
            />
          </div>
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="editor-input max-w-[170px]"
          >
            <option value="all">All projects</option>
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="editor-input max-w-[160px]"
          >
            <option value="all">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="editor-input max-w-[140px]"
          >
            <option value="all">All sources</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <Link
          to="/resources/new"
          className="inline-flex h-9 items-center gap-2 rounded-md bg-foreground px-3 text-sm font-medium text-background transition hover:bg-foreground/90"
        >
          <Plus className="h-4 w-4" />
          New Resource
        </Link>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={resources.length === 0 ? 'No resources yet' : 'No resources match these filters'}
          description={
            resources.length === 0
              ? 'Resources are reference materials shared across a project — specs, requirements, links, or any reference content.'
              : 'Clear the current filters or create a new resource.'
          }
          actions={
            resources.length === 0 ? (
              <Link
                to="/resources/new"
                className="inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background transition hover:bg-foreground/90"
              >
                <Plus className="h-4 w-4" />
                New Resource
              </Link>
            ) : undefined
          }
        />
      ) : (
        <div className="surface-panel overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead>
              <tr className="border-b border-border/60 text-muted-foreground">
                <th className="px-3 pb-3 pt-3 font-medium">Name</th>
                <th className="px-3 pb-3 pt-3 font-medium">Project</th>
                <th className="px-3 pb-3 pt-3 font-medium">Category</th>
                <th className="px-3 pb-3 pt-3 font-medium">Source</th>
                <th className="px-3 pb-3 pt-3 font-medium"># Related</th>
                <th className="px-3 pb-3 pt-3 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((resource) => (
                <tr
                  key={`${resource.projectSlug}/${resource.slug}`}
                  className="border-b border-border/50 last:border-0"
                >
                  <td className="px-3 py-3">
                    <Link
                      to={`/projects/${resource.projectSlug}/resources/${resource.slug}`}
                      className="font-semibold text-foreground hover:text-primary"
                    >
                      {resource.name || resource.slug}
                    </Link>
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">
                    <Link
                      to={`/projects/${resource.projectSlug}`}
                      className="hover:text-foreground hover:underline"
                    >
                      {resource.projectTitle}
                    </Link>
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">{resource.category || '—'}</td>
                  <td className="px-3 py-3 text-muted-foreground">{resource.source || '—'}</td>
                  <td className="px-3 py-3 text-muted-foreground">
                    {resource.relatedAssignments.length}
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">
                    {formatDate(resource.updated)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
