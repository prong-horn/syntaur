import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import { useMemories } from '../hooks/useProjects';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { formatDate } from '../lib/format';

export function MemoriesPage() {
  const { data, loading, error } = useMemories();
  const [search, setSearch] = useState('');
  const [projectFilter, setProjectFilter] = useState('all');
  const [scopeFilter, setScopeFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');

  const memories = data?.memories ?? [];

  const projects = useMemo(
    () => Array.from(new Set(memories.map((m) => m.projectSlug))).sort(),
    [memories],
  );
  const scopes = useMemo(
    () => Array.from(new Set(memories.map((m) => m.scope).filter(Boolean))).sort(),
    [memories],
  );
  const sources = useMemo(
    () => Array.from(new Set(memories.map((m) => m.source).filter(Boolean))).sort(),
    [memories],
  );

  const filtered = useMemo(() => {
    return memories.filter((m) => {
      if (projectFilter !== 'all' && m.projectSlug !== projectFilter) return false;
      if (scopeFilter !== 'all' && m.scope !== scopeFilter) return false;
      if (sourceFilter !== 'all' && m.source !== sourceFilter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        if (
          !m.name.toLowerCase().includes(q) &&
          !m.slug.toLowerCase().includes(q) &&
          !m.projectTitle.toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [memories, search, projectFilter, scopeFilter, sourceFilter]);

  if (loading) return <LoadingState label="Loading memories…" />;
  if (error) return <ErrorState error={error} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search memories…"
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
            value={scopeFilter}
            onChange={(e) => setScopeFilter(e.target.value)}
            className="editor-input max-w-[140px]"
          >
            <option value="all">All scopes</option>
            {scopes.map((s) => (
              <option key={s} value={s}>
                {s}
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
          to="/memories/new"
          className="inline-flex h-9 items-center gap-2 rounded-md bg-foreground px-3 text-sm font-medium text-background transition hover:bg-foreground/90"
        >
          <Plus className="h-4 w-4" />
          New Memory
        </Link>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={memories.length === 0 ? 'No memories yet' : 'No memories match these filters'}
          description={
            memories.length === 0
              ? 'Memories capture patterns and learnings discovered while working in a project. Agents create them via /create-memory or you can add one manually.'
              : 'Clear the current filters or create a new memory.'
          }
          actions={
            memories.length === 0 ? (
              <Link
                to="/memories/new"
                className="inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background transition hover:bg-foreground/90"
              >
                <Plus className="h-4 w-4" />
                New Memory
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
                <th className="px-3 pb-3 pt-3 font-medium">Scope</th>
                <th className="px-3 pb-3 pt-3 font-medium">Source</th>
                <th className="px-3 pb-3 pt-3 font-medium"># Related</th>
                <th className="px-3 pb-3 pt-3 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((memory) => (
                <tr
                  key={`${memory.projectSlug}/${memory.slug}`}
                  className="border-b border-border/50 last:border-0"
                >
                  <td className="px-3 py-3">
                    <Link
                      to={`/projects/${memory.projectSlug}/memories/${memory.slug}`}
                      className="font-semibold text-foreground hover:text-primary"
                    >
                      {memory.name || memory.slug}
                    </Link>
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">
                    <Link
                      to={`/projects/${memory.projectSlug}`}
                      className="hover:text-foreground hover:underline"
                    >
                      {memory.projectTitle}
                    </Link>
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">{memory.scope || '—'}</td>
                  <td className="px-3 py-3 text-muted-foreground">{memory.source || '—'}</td>
                  <td className="px-3 py-3 text-muted-foreground">
                    {memory.relatedAssignments.length}
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">{formatDate(memory.updated)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
