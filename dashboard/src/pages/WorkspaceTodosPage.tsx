import { useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import {
  CheckSquare,
  Plus,
  Search,
  AlertTriangle,
  Copy,
  Check,
} from 'lucide-react';
import {
  useTodos,
  addTodo,
  completeTodo,
  blockTodo,
  startTodo,
  reopenTodo,
} from '../hooks/useTodos';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { StatCard } from '../components/StatCard';
import { StatusMenu } from '../components/StatusMenu';

export function WorkspaceTodosPage() {
  const { workspace } = useParams<{ workspace: string }>();
  const ws = workspace || '_global';
  const { data, loading, error, refetch } = useTodos(ws);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [tagFilter, setTagFilter] = useState<string>('');
  const [newTodoText, setNewTodoText] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  function copyId(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    navigator.clipboard.writeText(id);
    setCopiedId(id);
    setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
  }

  const allTags = useMemo(() => {
    if (!data?.items) return [];
    const tags = new Set<string>();
    for (const item of data.items) {
      for (const tag of item.tags) tags.add(tag);
    }
    return Array.from(tags).sort();
  }, [data]);

  const filtered = useMemo(() => {
    if (!data?.items) return [];
    let items = data.items;
    if (search.trim()) {
      const q = search.toLowerCase();
      items = items.filter(
        (i) =>
          i.description.toLowerCase().includes(q) ||
          i.tags.some((t) => t.toLowerCase().includes(q)) ||
          i.id.includes(q),
      );
    }
    if (statusFilter) items = items.filter((i) => i.status === statusFilter);
    if (tagFilter) items = items.filter((i) => i.tags.includes(tagFilter));
    return items;
  }, [data, search, statusFilter, tagFilter]);

  async function handleAdd() {
    if (!newTodoText.trim()) return;
    await addTodo(ws, newTodoText.trim());
    setNewTodoText('');
    refetch();
  }

  const NEXT_STATUS: Record<string, string> = {
    open: 'in_progress',
    in_progress: 'completed',
    completed: 'open',
    blocked: 'open',
  };

  function handleCycleStatus(id: string, currentStatus: string) {
    handleStatusChange(id, NEXT_STATUS[currentStatus] || 'open');
  }

  async function handleStatusChange(id: string, newStatus: string) {
    switch (newStatus) {
      case 'open':
        await reopenTodo(ws, id);
        break;
      case 'in_progress':
        await startTodo(ws, id);
        break;
      case 'completed':
        await completeTodo(ws, id);
        break;
      case 'blocked':
        await blockTodo(ws, id);
        break;
    }
    refetch();
  }


  if (loading) return <LoadingState label="Loading todos..." />;
  if (error) return <ErrorState error={error} />;

  const counts = data?.counts || { open: 0, in_progress: 0, completed: 0, blocked: 0, total: 0 };

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(140px,1fr))]">
        <StatCard label="Open" value={counts.open} icon={CheckSquare} />
        <StatCard label="In Progress" value={counts.in_progress} icon={CheckSquare} tone="info" />
        <StatCard label="Blocked" value={counts.blocked} icon={AlertTriangle} tone="warn" />
        <StatCard label="Total" value={counts.total} icon={CheckSquare} />
      </div>

      {/* Add todo */}
      <div className="surface-panel p-3">
        <div className="flex gap-2">
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
            placeholder="Search..."
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
          description="Add your first todo above."
        />
      ) : (
        <div className="space-y-1">
          {filtered.map((item) => (
            <div
              key={item.id}
              className="surface-panel flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-foreground/[0.03] transition"
              onClick={() => handleCycleStatus(item.id, item.status)}
            >
              <StatusMenu
                status={item.status as any}
                onChange={(s) => handleStatusChange(item.id, s)}
              />
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
                {item.session && (
                  <span className="ml-2 text-xs text-blue-400/60 font-mono">
                    session:{item.session.slice(0, 8)}
                  </span>
                )}
              </div>
              {copiedId === item.id ? (
                <span className="text-xs text-emerald-400 flex items-center gap-1">
                  <Check className="h-3 w-3" /> Copied to clipboard
                </span>
              ) : (
                <>
                  <button
                    className="text-xs text-muted-foreground/60 font-mono hover:text-foreground transition"
                    onClick={(e) => copyId(e, item.id)}
                  >
                    t:{item.id}
                  </button>
                  <button
                    className="text-muted-foreground/40 hover:text-foreground transition"
                    title="Copy ID"
                    onClick={(e) => copyId(e, item.id)}
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
