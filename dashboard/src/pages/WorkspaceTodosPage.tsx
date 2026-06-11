import { useState, useMemo, useEffect, useRef, type DragEvent } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { CheckSquare, Plus, Search, AlertTriangle } from 'lucide-react';
import {
  useTodos,
  addTodo,
  completeTodo,
  blockTodo,
  startTodo,
  reopenTodo,
  deleteTodo,
  patchTodo,
  addTodoAttachments,
  deleteTodoAttachment,
  todoAttachmentUrl,
} from '../hooks/useTodos';
import { copyText } from '../lib/clipboard';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { StatCard } from '../components/StatCard';
import { TodoRow } from '../components/TodoRow';
import { TodoPromoteModal } from '../components/TodoPromoteModal';
import { TodoMoveModal } from '../components/TodoMoveModal';
import { BundleSection } from '../components/BundleRow';
import { useBundles } from '../hooks/useBundles';
import { useHotkey, useHotkeyScope, useListSelection } from '../hotkeys';
import { NON_DRAGGABLE_SELECTOR } from '../components/KanbanBoard';
import { TodoAccordionSection } from '../components/TodoAccordionSection';
import { useTodoSectionCollapse } from '../hooks/useTodoSectionCollapse';
import {
  groupTodosBySections,
  sectionIdForStatus,
  type TodoSectionConfig,
  type TodoSectionId,
} from '@shared/todo-sections';

export function WorkspaceTodosPage() {
  const { workspace } = useParams<{ workspace: string }>();
  const ws = workspace || '_global';
  const { data, loading, error, refetch } = useTodos(ws);
  const { data: bundlesData } = useBundles(ws);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [tagFilter, setTagFilter] = useState<string>('');
  const [newTodoText, setNewTodoText] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveSingleId, setMoveSingleId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useHotkeyScope('list:todos');

  const collapse = useTodoSectionCollapse('workspace:' + ws);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTargetSection, setDropTargetSection] = useState<TodoSectionId | null>(null);
  // The dragstart event's target is the draggable row, not the grabbed child, so
  // record the actual mousedown target to gate drags from interactive controls.
  const dragOriginRef = useRef<EventTarget | null>(null);

  async function copyId(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    if (!(await copyText(id))) return;
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

  // Reset selection whenever the active filter changes — selection is filter-scoped.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [search, statusFilter, tagFilter, ws]);

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
    await addTodo(ws, newTodoText.trim());
    setNewTodoText('');
    refetch();
  }

  async function handleDelete(e: React.MouseEvent, id: string, description: string) {
    e.stopPropagation();
    if (!window.confirm(`Delete "${description}"? This can't be undone.`)) return;
    await deleteTodo(ws, id);
    refetch();
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

  async function handlePatchDescription(id: string, next: string) {
    await patchTodo(ws, id, next);
    refetch();
  }

  async function handleAddAttachments(id: string, files: File[]) {
    await addTodoAttachments(ws, id, files);
    refetch();
  }

  async function handleDeleteAttachment(id: string, attachmentId: string) {
    await deleteTodoAttachment(ws, id, attachmentId);
    refetch();
  }

  // Group the filtered todos into the three accordion sections. `renderedOrdered`
  // is the flat list of rows actually in the DOM (expanded sections only); it
  // must match what useListSelection queries via [data-hotkey-row-index].
  const sections = groupTodosBySections(filtered);
  const renderedOrdered = sections
    .filter((s) => !collapse.isCollapsed(s.config.id))
    .flatMap((s) => s.items);

  // Hotkey wiring (R3 + R5d).
  const { hotkeyRowProps } = useListSelection(renderedOrdered, {
    scope: 'list:todos',
    bindO: false,
    // Enter opens the inline editor — status changes only via the dot, never a cycle.
    onOpen: (todo) => setEditingId(todo.id),
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
  // collapsed by default). `collapse` is intentionally omitted from deps: its
  // identity changes every render and the isCollapsed guard makes any repeat a
  // no-op.
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
    if (!node) return; // retries when renderedOrdered.length changes (data arrives / section expands)
    node.scrollIntoView({ block: 'nearest' });
    node.classList.add('ring-2', 'ring-primary/60');
    const t = window.setTimeout(() => {
      node.classList.remove('ring-2', 'ring-primary/60');
      setSearchParams((prev) => {
        const n = new URLSearchParams(prev);
        n.delete('focus');
        return n;
      });
    }, 1500);
    return () => window.clearTimeout(t);
  }, [focusId, renderedOrdered.length, setSearchParams]);

  // --- Native drag-to-change-status (mirrors the AssignmentsPage list DnD) ---
  const draggedItem = draggedId ? data?.items.find((i) => i.id === draggedId) ?? null : null;

  function handleDragStart(e: DragEvent<HTMLDivElement>, id: string) {
    // Don't start a drag from an interactive control (checkbox, status menu,
    // buttons, links); let those handle their own clicks. Use the recorded
    // mousedown target — the dragstart target is the row itself.
    const origin = dragOriginRef.current as HTMLElement | null;
    if (origin?.closest(NON_DRAGGABLE_SELECTOR)) {
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

      {/* Bundles (read-only) */}
      {bundlesData && <BundleSection bundles={bundlesData.bundles} />}

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

      {/* Bulk toolbar (shows when ≥1 selected) */}
      {selectedIds.size > 0 ? (
        <div className="surface-panel flex items-center justify-between gap-3 px-3 py-2">
          <span className="text-sm font-medium">
            {selectedIds.size} selected
          </span>
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
                        editing={editingId === item.id}
                        onBeginEdit={(id) => setEditingId(id)}
                        onEndEdit={() => setEditingId(null)}
                        onPatchDescription={handlePatchDescription}
                        onAddAttachments={handleAddAttachments}
                        onDeleteAttachment={handleDeleteAttachment}
                        attachmentUrl={(id, attachmentId) => todoAttachmentUrl(ws, id, attachmentId)}
                        onToggleSelected={(id) => toggleOne(id)}
                        onMoveOne={(id, e) => { e.stopPropagation(); setMoveSingleId(id); setMoveOpen(true); }}
                        onStatusChange={handleStatusChange}
                        onCopyId={copyId}
                        onDelete={handleDelete}
                        hotkeyRowProps={hotkeyRowProps(flatIndex)}
                        onDragOrigin={(e) => { dragOriginRef.current = e.target; }}
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
        scope={{ kind: 'workspace', workspace: ws }}
        onOpenChange={setPromoteOpen}
        onDone={onPromoteDone}
      />
      <TodoMoveModal
        open={moveOpen}
        selectedIds={moveSelectedIds}
        scope={{ kind: 'workspace', workspace: ws }}
        onOpenChange={(o) => { setMoveOpen(o); if (!o) setMoveSingleId(null); }}
        onDone={onMoveDone}
      />
    </div>
  );
}
