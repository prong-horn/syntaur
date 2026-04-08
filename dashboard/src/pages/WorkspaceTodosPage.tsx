import { useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import {
  CheckSquare,
  Plus,
  Search,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import {
  useTodos,
  useTodoLog,
  addTodo,
  completeTodo,
  blockTodo,
  startTodo,
  unblockTodo,
  deleteTodo,
} from '../hooks/useTodos';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { StatCard } from '../components/StatCard';
import { formatDateTime } from '../lib/format';

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

function LogPanel({ workspace, id }: { workspace: string; id: string }) {
  const { entries, loading } = useTodoLog(workspace, id);

  if (loading) return <div className="text-xs text-muted-foreground py-1">Loading log...</div>;
  if (entries.length === 0)
    return <div className="text-xs text-muted-foreground py-1">No log entries.</div>;

  return (
    <div className="space-y-2 py-1">
      {entries.map((entry, i) => (
        <div key={i} className="text-xs text-muted-foreground border-l-2 border-border/50 pl-3">
          <div className="font-mono text-muted-foreground/60">{formatDateTime(entry.timestamp)}</div>
          {entry.summary && <div>{entry.summary}</div>}
          {entry.session && <div>Session: {entry.session}</div>}
          {entry.branch && <div>Branch: {entry.branch}</div>}
          {entry.blockers && <div className="text-amber-400">Blocker: {entry.blockers}</div>}
        </div>
      ))}
    </div>
  );
}

export function WorkspaceTodosPage() {
  const { workspace } = useParams<{ workspace: string }>();
  const ws = workspace || '_global';
  const { data, loading, error, refetch } = useTodos(ws);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [tagFilter, setTagFilter] = useState<string>('');
  const [newTodoText, setNewTodoText] = useState('');
  const [expandedLog, setExpandedLog] = useState<string | null>(null);
  const [blockingId, setBlockingId] = useState<string | null>(null);
  const [blockReason, setBlockReason] = useState('');

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

  async function handleStatusToggle(id: string, currentStatus: string) {
    switch (currentStatus) {
      case 'open':
        await startTodo(ws, id);
        break;
      case 'in_progress':
        await completeTodo(ws, id);
        break;
      case 'blocked':
        await unblockTodo(ws, id);
        break;
    }
    refetch();
  }

  async function handleBlock(id: string) {
    if (!blockReason.trim()) return;
    await blockTodo(ws, id, blockReason.trim());
    setBlockingId(null);
    setBlockReason('');
    refetch();
  }

  async function handleDelete(id: string) {
    await deleteTodo(ws, id);
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
            <div key={item.id}>
              <div className="surface-panel flex items-center gap-3 px-3 py-2 group">
                <button
                  onClick={() =>
                    item.status !== 'completed' && handleStatusToggle(item.id, item.status)
                  }
                  className={`text-lg leading-none ${STATUS_COLORS[item.status]} hover:opacity-70 transition`}
                  title={
                    item.status === 'open'
                      ? 'Start'
                      : item.status === 'in_progress'
                        ? 'Complete'
                        : item.status === 'blocked'
                          ? 'Unblock'
                          : 'Done'
                  }
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
                  {item.session && (
                    <span className="ml-2 text-xs text-blue-400/60 font-mono">
                      session:{item.session.slice(0, 8)}
                    </span>
                  )}
                </div>
                <span className="text-xs text-muted-foreground/60 font-mono">t:{item.id}</span>
                <button
                  onClick={() => setExpandedLog(expandedLog === item.id ? null : item.id)}
                  className="text-muted-foreground/40 hover:text-foreground transition"
                  title="Toggle log"
                >
                  {expandedLog === item.id ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </button>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition">
                  {item.status !== 'blocked' && item.status !== 'completed' && (
                    <button
                      onClick={() => setBlockingId(blockingId === item.id ? null : item.id)}
                      className="text-xs text-muted-foreground/40 hover:text-amber-400 transition"
                    >
                      block
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(item.id)}
                    className="text-xs text-muted-foreground/40 hover:text-red-400 transition"
                  >
                    delete
                  </button>
                </div>
              </div>
              {blockingId === item.id && (
                <div className="surface-panel border-t-0 px-3 py-2 flex gap-2">
                  <input
                    type="text"
                    placeholder="Reason for blocking..."
                    value={blockReason}
                    onChange={(e) => setBlockReason(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleBlock(item.id)}
                    className="h-8 flex-1 rounded-md border border-border/70 bg-background px-3 text-xs text-foreground focus:border-foreground/30 focus:outline-none"
                    autoFocus
                  />
                  <button
                    onClick={() => handleBlock(item.id)}
                    disabled={!blockReason.trim()}
                    className="h-8 rounded-md bg-amber-500/20 px-2 text-xs text-amber-400 hover:bg-amber-500/30 disabled:opacity-40"
                  >
                    Block
                  </button>
                </div>
              )}
              {expandedLog === item.id && (
                <div className="surface-panel border-t-0 px-3 py-2 pl-10">
                  <LogPanel workspace={ws} id={item.id} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
