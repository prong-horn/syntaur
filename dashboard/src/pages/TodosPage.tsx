import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { CheckSquare, Plus, Search, AlertTriangle, Loader2 } from 'lucide-react';
import { useAllTodos, addTodo, completeTodo, deleteTodo } from '../hooks/useTodos';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { StatCard } from '../components/StatCard';
import type { TodoItem } from '../types';

const STATUS_ICONS: Record<string, string> = {
  open: '○',
  in_progress: '◉',
  completed: '✓',
  blocked: '✕',
};

const STATUS_COLORS: Record<string, string> = {
  open: 'text-muted-foreground',
  in_progress: 'text-blue-400',
  completed: 'text-emerald-400',
  blocked: 'text-amber-400',
};

export function TodosPage() {
  const { data, loading, error, refetch } = useAllTodos();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [tagFilter, setTagFilter] = useState<string>('');
  const [newTodoText, setNewTodoText] = useState('');
  const [newTodoWorkspace, setNewTodoWorkspace] = useState('_global');

  const allItems = useMemo(() => {
    if (!data?.workspaces) return [];
    const items: Array<TodoItem & { workspace: string }> = [];
    for (const ws of data.workspaces) {
      for (const item of ws.items) {
        items.push({ ...item, workspace: ws.workspace });
      }
    }
    return items;
  }, [data]);

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    for (const item of allItems) {
      for (const tag of item.tags) tags.add(tag);
    }
    return Array.from(tags).sort();
  }, [allItems]);

  const filtered = useMemo(() => {
    let items = allItems;
    if (search.trim()) {
      const q = search.toLowerCase();
      items = items.filter(
        (i) =>
          i.description.toLowerCase().includes(q) ||
          i.tags.some((t) => t.toLowerCase().includes(q)) ||
          i.id.includes(q),
      );
    }
    if (statusFilter) {
      items = items.filter((i) => i.status === statusFilter);
    }
    if (tagFilter) {
      items = items.filter((i) => i.tags.includes(tagFilter));
    }
    return items;
  }, [allItems, search, statusFilter, tagFilter]);

  const totalCounts = useMemo(() => {
    if (!data?.workspaces) return { open: 0, in_progress: 0, completed: 0, blocked: 0, total: 0 };
    const c = { open: 0, in_progress: 0, completed: 0, blocked: 0, total: 0 };
    for (const ws of data.workspaces) {
      c.open += ws.counts.open;
      c.in_progress += ws.counts.in_progress;
      c.completed += ws.counts.completed;
      c.blocked += ws.counts.blocked;
      c.total += ws.counts.total;
    }
    return c;
  }, [data]);

  async function handleAdd() {
    if (!newTodoText.trim()) return;
    await addTodo(newTodoWorkspace, newTodoText.trim());
    setNewTodoText('');
    refetch();
  }

  async function handleComplete(workspace: string, id: string) {
    await completeTodo(workspace, id);
    refetch();
  }

  async function handleDelete(workspace: string, id: string) {
    await deleteTodo(workspace, id);
    refetch();
  }

  if (loading) return <LoadingState label="Loading todos..." />;
  if (error) return <ErrorState error={error} />;

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(140px,1fr))]">
        <StatCard label="Open" value={totalCounts.open} icon={CheckSquare} />
        <StatCard label="In Progress" value={totalCounts.in_progress} icon={Loader2} tone="info" />
        <StatCard label="Blocked" value={totalCounts.blocked} icon={AlertTriangle} tone="warn" />
        <StatCard label="Completed" value={totalCounts.completed} icon={CheckSquare} tone="default" />
      </div>

      {/* Add todo */}
      <div className="surface-panel p-3">
        <div className="flex gap-2">
          <select
            value={newTodoWorkspace}
            onChange={(e) => setNewTodoWorkspace(e.target.value)}
            className="h-9 rounded-md border border-border/70 bg-background px-2 text-sm text-foreground focus:border-foreground/30 focus:outline-none"
          >
            <option value="_global">Global</option>
            {data?.workspaces
              .filter((w) => w.workspace !== '_global')
              .map((w) => (
                <option key={w.workspace} value={w.workspace}>
                  {w.workspace}
                </option>
              ))}
          </select>
          <input
            type="text"
            placeholder="Add a todo..."
            value={newTodoText}
            onChange={(e) => setNewTodoText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            className="h-9 flex-1 rounded-md border border-border/70 bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-foreground/30 focus:outline-none"
          />
          <button
            onClick={handleAdd}
            disabled={!newTodoText.trim()}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-foreground px-3 text-sm font-medium text-background transition hover:bg-foreground/90 disabled:opacity-40"
          >
            <Plus className="h-4 w-4" />
            Add
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search todos..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 w-full rounded-md border border-border/70 bg-background pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-foreground/30 focus:outline-none"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-9 rounded-md border border-border/70 bg-background px-2 text-sm text-foreground focus:border-foreground/30 focus:outline-none"
        >
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="in_progress">In Progress</option>
          <option value="completed">Completed</option>
          <option value="blocked">Blocked</option>
        </select>
        {allTags.length > 0 && (
          <select
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
            className="h-9 rounded-md border border-border/70 bg-background px-2 text-sm text-foreground focus:border-foreground/30 focus:outline-none"
          >
            <option value="">All tags</option>
            {allTags.map((t) => (
              <option key={t} value={t}>
                #{t}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Items */}
      {filtered.length === 0 ? (
        <EmptyState
          title="No todos"
          description="Add your first todo above or use the CLI: syntaur todo add"
        />
      ) : (
        <div className="space-y-1">
          {filtered.map((item) => (
            <div
              key={`${item.workspace}-${item.id}`}
              className="surface-panel flex items-center gap-3 px-3 py-2 group"
            >
              <button
                onClick={() =>
                  item.status !== 'completed'
                    ? handleComplete(item.workspace, item.id)
                    : undefined
                }
                className={`text-lg leading-none ${STATUS_COLORS[item.status]} hover:opacity-70 transition`}
                title={item.status === 'completed' ? 'Completed' : 'Click to complete'}
              >
                {STATUS_ICONS[item.status]}
              </button>
              <div className="flex-1 min-w-0">
                <span
                  className={`text-sm ${item.status === 'completed' ? 'line-through text-muted-foreground' : 'text-foreground'}`}
                >
                  {item.description}
                </span>
                {item.tags.length > 0 && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {item.tags.map((t) => `#${t}`).join(' ')}
                  </span>
                )}
              </div>
              <span className="text-xs text-muted-foreground/60 font-mono">
                {item.workspace !== '_global' && (
                  <Link
                    to={`/w/${item.workspace}/todos`}
                    className="hover:text-foreground transition mr-2"
                  >
                    {item.workspace}
                  </Link>
                )}
                t:{item.id}
              </span>
              <button
                onClick={() => handleDelete(item.workspace, item.id)}
                className="text-xs text-muted-foreground/40 hover:text-red-400 transition opacity-0 group-hover:opacity-100"
              >
                delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
