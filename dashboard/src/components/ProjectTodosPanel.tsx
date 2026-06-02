import { useState, useMemo, useEffect, useRef, type DragEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  CheckSquare,
  Plus,
  Search,
  AlertTriangle,
  Copy,
  Check,
  Trash2,
  ArrowRightLeft,
} from 'lucide-react';
import {
  useProjectTodos,
  addProjectTodo,
  completeProjectTodo,
  blockProjectTodo,
  startProjectTodo,
  reopenProjectTodo,
  deleteProjectTodo,
} from '../hooks/useProjectTodos';
import { LoadingState } from './LoadingState';
import { ErrorState } from './ErrorState';
import { StatCard } from './StatCard';
import { StatusMenu } from './StatusMenu';
import { TodoPromoteModal } from './TodoPromoteModal';
import { TodoMoveModal } from './TodoMoveModal';
import { TodoMetaBadges } from '../pages/WorkspaceTodosPage';
import { NON_DRAGGABLE_SELECTOR } from './KanbanBoard';
import { TodoAccordionSection } from './TodoAccordionSection';
import { useTodoSectionCollapse } from '../hooks/useTodoSectionCollapse';
import {
  groupTodosBySections,
  sectionIdForStatus,
  type TodoSectionConfig,
  type TodoSectionId,
} from '@shared/todo-sections';
import type { TodoItem } from '../types';
import { useHotkey, useHotkeyScope, useListSelection } from '../hotkeys';

interface TodoRowProps {
  item: TodoItem;
  copiedId: string | null;
  selected: boolean;
  onToggleSelected: (id: string, e: React.MouseEvent | React.ChangeEvent) => void;
  onMoveOne: (id: string, e: React.MouseEvent) => void;
  onCycleStatus: (id: string, status: string) => void;
  onStatusChange: (id: string, status: string) => void;
  onCopyId: (e: React.MouseEvent, id: string) => void;
  onDelete: (e: React.MouseEvent, id: string, description: string) => void;
  hotkeyRowProps?: Record<string, string | number | boolean>;
  onDragStart: (e: DragEvent<HTMLDivElement>, id: string) => void;
  onDragEnd: () => void;
  isDragging: boolean;
}

function TodoRow({
  item,
  copiedId,
  selected,
  onToggleSelected,
  onMoveOne,
  onCycleStatus,
  onStatusChange,
  onCopyId,
  onDelete,
  hotkeyRowProps,
  onDragStart,
  onDragEnd,
  isDragging,
}: TodoRowProps) {
  return (
    <div
      draggable
      data-todo-id={item.id}
      {...(hotkeyRowProps ?? {})}
      onDragStart={(e) => onDragStart(e, item.id)}
      onDragEnd={onDragEnd}
      className={`surface-panel flex items-center gap-3 px-3 py-2 cursor-grab active:cursor-grabbing hover:bg-foreground/[0.03] transition ${
        isDragging ? 'opacity-50 shadow-lg' : ''
      }`}
      onClick={() => onCycleStatus(item.id, item.status)}
    >
      <input
        type="checkbox"
        aria-label={`Select todo ${item.id}`}
        checked={selected}
        onChange={(e) => onToggleSelected(item.id, e)}
        onClick={(e) => e.stopPropagation()}
        className="h-4 w-4 cursor-pointer accent-foreground"
      />
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
          <span className="ml-2 text-xs text-info-foreground/70 font-mono">
            session:{item.session.slice(0, 8)}
          </span>
        )}
        <TodoMetaBadges item={item} />
      </div>
      {copiedId === item.id ? (
        <span className="text-xs text-status-completed-foreground flex items-center gap-1">
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
          <button
            className="text-muted-foreground/40 hover:text-foreground transition"
            title="Move to..."
            onClick={(e) => onMoveOne(item.id, e)}
          >
            <ArrowRightLeft className="h-3 w-3" />
          </button>
          <button
            className="text-muted-foreground/40 hover:text-destructive transition"
            title="Delete todo"
            onClick={(e) => onDelete(e, item.id, item.description)}
          >
            <Trash2 className="h-3 w-3" />
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveSingleId, setMoveSingleId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useHotkeyScope('list:todos');

  const collapse = useTodoSectionCollapse('project:' + projectId);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTargetSection, setDropTargetSection] = useState<TodoSectionId | null>(null);

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

  useEffect(() => {
    setSelectedIds(new Set());
  }, [search, statusFilter, tagFilter, projectId]);

  const visibleSelectedCount = useMemo(
    () => filtered.filter((i) => selectedIds.has(i.id)).length,
    [filtered, selectedIds],
  );
  const allVisibleSelected = filtered.length > 0 && visibleSelectedCount === filtered.length;
  const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected;

  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAllVisible() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const i of filtered) next.delete(i.id);
      } else {
        for (const i of filtered) next.add(i.id);
      }
      return next;
    });
  }
  function clearSelection() { setSelectedIds(new Set()); }

  const moveSelectedIds = moveSingleId ? [moveSingleId] : Array.from(selectedIds);
  function onMoveDone() {
    setSelectedIds(new Set());
    setMoveSingleId(null);
    refetch();
  }
  function onPromoteDone() {
    setSelectedIds(new Set());
    refetch();
  }

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

  async function handleDelete(e: React.MouseEvent, id: string, description: string) {
    e.stopPropagation();
    if (!window.confirm(`Delete "${description}"? This can't be undone.`)) return;
    await deleteProjectTodo(projectId, id);
    refetch();
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

  // Group the filtered todos into the three accordion sections. `renderedOrdered`
  // is the flat list of rows actually in the DOM (expanded sections only); it
  // must match what useListSelection queries via [data-hotkey-row-index].
  const sections = groupTodosBySections(filtered);
  const renderedOrdered = sections
    .filter((s) => !collapse.isCollapsed(s.config.id))
    .flatMap((s) => s.items);

  const { hotkeyRowProps } = useListSelection(renderedOrdered, {
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
  // Expand the section holding a ?focus= target so its row can render (Done is
  // collapsed by default). `collapse` is intentionally omitted from deps.
  useEffect(() => {
    if (!focusId || !data?.items) return;
    const target = data.items.find((i) => i.id === focusId);
    if (!target) return;
    const sectionId = sectionIdForStatus(target.status);
    if (collapse.isCollapsed(sectionId)) collapse.toggle(sectionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, data?.items]);
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
  }, [focusId, renderedOrdered.length, setSearchParams]);

  // --- Native drag-to-change-status (mirrors the AssignmentsPage list DnD) ---
  const draggedItem = draggedId ? data?.items.find((i) => i.id === draggedId) ?? null : null;

  function handleDragStart(e: DragEvent<HTMLDivElement>, id: string) {
    // Don't start a drag from an interactive control; let those handle clicks.
    const target = e.target as HTMLElement | null;
    if (target?.closest(NON_DRAGGABLE_SELECTOR)) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
    setDraggedId(id);
  }

  function handleDragEnd() {
    setDraggedId(null);
    setDropTargetSection(null);
  }

  function handleSectionDragOver(e: DragEvent<HTMLElement>, config: TodoSectionConfig) {
    if (!draggedItem || config.statuses.includes(draggedItem.status)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTargetSection(config.id);
  }

  function handleSectionDragLeave(e: DragEvent<HTMLElement>, config: TodoSectionConfig) {
    if (dropTargetSection === config.id && !e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropTargetSection(null);
    }
  }

  function handleSectionDrop(e: DragEvent<HTMLElement>, config: TodoSectionConfig) {
    e.preventDefault();
    const item = draggedItem;
    handleDragEnd();
    if (!item || config.statuses.includes(item.status)) return;
    handleStatusChange(item.id, config.dropStatus);
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

      {/* Bulk toolbar */}
      {selectedIds.size > 0 ? (
        <div className="surface-panel flex items-center justify-between gap-3 px-3 py-2">
          <span className="text-sm font-medium">{selectedIds.size} selected</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPromoteOpen(true)}
              className="shell-action shell-action--cta"
            >
              Promote selected
            </button>
            <button
              type="button"
              onClick={() => { setMoveSingleId(null); setMoveOpen(true); }}
              className="shell-action"
            >
              Move to…
            </button>
            <button
              type="button"
              onClick={clearSelection}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          </div>
        </div>
      ) : null}

      {/* Items — accordion sections by status */}
      {filtered.length > 0 && (
        <div className="flex items-center gap-3 px-3 py-1 text-xs text-muted-foreground">
          <input
            type="checkbox"
            aria-label="Select all visible todos"
            checked={allVisibleSelected}
            ref={(el) => { if (el) el.indeterminate = someVisibleSelected; }}
            onChange={toggleAllVisible}
            className="h-4 w-4 cursor-pointer accent-foreground"
          />
          <span>Select all in current filter ({filtered.length})</span>
        </div>
      )}
      <div className="space-y-3">
        {(() => {
          let flatIndex = -1;
          return sections.map(({ config, items }) => {
            const expanded = !collapse.isCollapsed(config.id);
            return (
              <TodoAccordionSection
                key={config.id}
                label={config.label}
                count={items.length}
                expanded={expanded}
                onToggle={() => collapse.toggle(config.id)}
                isDropTarget={dropTargetSection === config.id}
                onDragOver={(e) => handleSectionDragOver(e, config)}
                onDragLeave={(e) => handleSectionDragLeave(e, config)}
                onDrop={(e) => handleSectionDrop(e, config)}
              >
                {expanded &&
                  items.map((item) => {
                    flatIndex += 1;
                    return (
                      <TodoRow
                        key={item.id}
                        item={item}
                        copiedId={copiedId}
                        selected={selectedIds.has(item.id)}
                        onToggleSelected={(id) => toggleOne(id)}
                        onMoveOne={(id, e) => { e.stopPropagation(); setMoveSingleId(id); setMoveOpen(true); }}
                        onCycleStatus={handleCycleStatus}
                        onStatusChange={handleStatusChange}
                        onCopyId={copyId}
                        onDelete={handleDelete}
                        hotkeyRowProps={hotkeyRowProps(flatIndex)}
                        onDragStart={handleDragStart}
                        onDragEnd={handleDragEnd}
                        isDragging={draggedId === item.id}
                      />
                    );
                  })}
              </TodoAccordionSection>
            );
          });
        })()}
      </div>

      <TodoPromoteModal
        open={promoteOpen}
        selectedIds={Array.from(selectedIds)}
        scope={{ kind: 'project', projectId }}
        onOpenChange={setPromoteOpen}
        onDone={onPromoteDone}
      />
      <TodoMoveModal
        open={moveOpen}
        selectedIds={moveSelectedIds}
        scope={{ kind: 'project', projectId }}
        onOpenChange={(o) => { setMoveOpen(o); if (!o) setMoveSingleId(null); }}
        onDone={onMoveDone}
      />
    </div>
  );
}
