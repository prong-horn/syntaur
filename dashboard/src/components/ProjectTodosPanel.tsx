import { useState, useMemo, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  CheckSquare,
  Plus,
  Search,
  AlertTriangle,
  Copy,
  Check,
  GripVertical,
} from 'lucide-react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  useProjectTodos,
  addProjectTodo,
  completeProjectTodo,
  blockProjectTodo,
  startProjectTodo,
  reopenProjectTodo,
  reorderProjectTodos,
} from '../hooks/useProjectTodos';
import { LoadingState } from './LoadingState';
import { ErrorState } from './ErrorState';
import { EmptyState } from './EmptyState';
import { StatCard } from './StatCard';
import { StatusMenu } from './StatusMenu';
import type { TodoItem } from '../types';
import { useHotkey, useHotkeyScope, useListSelection } from '../hotkeys';

interface SortableTodoRowProps {
  item: TodoItem;
  copiedId: string | null;
  onCycleStatus: (id: string, status: string) => void;
  onStatusChange: (id: string, status: string) => void;
  onCopyId: (e: React.MouseEvent, id: string) => void;
  disabled: boolean;
  hotkeyRowProps?: Record<string, string | number | boolean>;
  rowIndex?: number;
}

function SortableTodoRow({
  item,
  copiedId,
  onCycleStatus,
  onStatusChange,
  onCopyId,
  disabled,
  hotkeyRowProps,
}: SortableTodoRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id, disabled });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    position: isDragging ? 'relative' as const : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-todo-id={item.id}
      {...(hotkeyRowProps ?? {})}
      className={`surface-panel flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-foreground/[0.03] transition ${
        isDragging ? 'opacity-50 shadow-lg' : ''
      }`}
      onClick={() => onCycleStatus(item.id, item.status)}
    >
      {!disabled && (
        <button
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-muted-foreground transition touch-none"
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="h-4 w-4" />
        </button>
      )}
      <StatusMenu
        status={item.status as any}
        onChange={(s) => onStatusChange(item.id, s)}
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
            onClick={(e) => onCopyId(e, item.id)}
          >
            t:{item.id}
          </button>
          <button
            className="text-muted-foreground/40 hover:text-foreground transition"
            title="Copy ID"
            onClick={(e) => onCopyId(e, item.id)}
          >
            <Copy className="h-3 w-3" />
          </button>
        </>
      )}
    </div>
  );
}

interface ProjectTodosPanelProps {
  projectId: string;
}

export function ProjectTodosPanel({ projectId }: ProjectTodosPanelProps) {
  const { data, loading, error, refetch } = useProjectTodos(projectId);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [tagFilter, setTagFilter] = useState<string>('');
  const [newTodoText, setNewTodoText] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useHotkeyScope('list:todos');

  const isFiltered = !!(search.trim() || statusFilter || tagFilter);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );

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
    await addProjectTodo(projectId, newTodoText.trim());
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
        await reopenProjectTodo(projectId, id);
        break;
      case 'in_progress':
        await startProjectTodo(projectId, id);
        break;
      case 'completed':
        await completeProjectTodo(projectId, id);
        break;
      case 'blocked':
        await blockProjectTodo(projectId, id);
        break;
    }
    refetch();
  }

  const { hotkeyRowProps } = useListSelection(filtered, {
    scope: 'list:todos',
    bindO: false,
    onOpen: (todo) => handleCycleStatus(todo.id, todo.status),
  });
  useHotkey({
    keys: '/',
    scope: 'list:todos',
    description: 'Focus filter',
    handler: () => searchRef.current?.focus(),
  });
  useHotkey({
    keys: 'r',
    scope: 'list:todos',
    description: 'Refresh',
    handler: () => refetch(),
  });

  // ?focus=<id> handler — retries until target row renders.
  const [searchParams, setSearchParams] = useSearchParams();
  const focusId = searchParams.get('focus');
  useEffect(() => {
    if (!focusId) return;
    const node = document.querySelector<HTMLElement>(
      `[data-todo-id="${window.CSS.escape(focusId)}"]`,
    );
    if (!node) return;
    node.scrollIntoView({ block: 'nearest' });
    node.classList.add('ring-2', 'ring-primary/60');
    const t = window.setTimeout(() => {
      node.classList.remove('ring-2', 'ring-primary/60');
      setSearchParams(
        (prev) => {
          const n = new URLSearchParams(prev);
          n.delete('focus');
          return n;
        },
        { replace: true },
      );
    }, 1500);
    return () => window.clearTimeout(t);
  }, [focusId, filtered.length, setSearchParams]);

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id || !data?.items) return;

    const oldIndex = data.items.findIndex((i) => i.id === active.id);
    const newIndex = data.items.findIndex((i) => i.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(data.items, oldIndex, newIndex);
    await reorderProjectTodos(projectId, reordered.map((i) => i.id));
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
            ref={searchRef}
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
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={filtered.map((i) => i.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-1">
              {filtered.map((item, i) => (
                <SortableTodoRow
                  key={item.id}
                  item={item}
                  copiedId={copiedId}
                  onCycleStatus={handleCycleStatus}
                  onStatusChange={handleStatusChange}
                  onCopyId={copyId}
                  disabled={isFiltered}
                  hotkeyRowProps={hotkeyRowProps(i)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}
