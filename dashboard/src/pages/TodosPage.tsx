import { useState, useMemo, useEffect, useRef, type DragEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  CheckSquare,
  Plus,
  Search,
  AlertTriangle,
  Loader2,
  Copy,
  Check,
  ArrowRight,
} from 'lucide-react';
import {
  useAllTodos,
  addTodo,
  completeTodo,
  startTodo,
  blockTodo,
  reopenTodo,
  deleteTodo,
  type PromoteResult,
  type BulkPromoteResult,
} from '../hooks/useTodos';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { StatCard } from '../components/StatCard';
import { StatusMenu } from '../components/StatusMenu';
import { TodoPromoteModal, type PromoteScope } from '../components/TodoPromoteModal';
import { NON_DRAGGABLE_SELECTOR } from '../components/KanbanBoard';
import { TodoAccordionSection } from '../components/TodoAccordionSection';
import { useTodoSectionCollapse } from '../hooks/useTodoSectionCollapse';
import {
  groupTodosBySections,
  sectionIdForStatus,
  type TodoSectionConfig,
  type TodoSectionId,
} from '@shared/todo-sections';
import type { TodoItem } from '../types';
import type { ProjectSummary } from '../hooks/useProjects';
import { useHotkey, useHotkeyScope, useListSelection } from '../hotkeys';

type AggregatedTodo = TodoItem & { workspace: string };
type SelKey = string; // `${workspace}::${id}`
const keyOf = (it: { workspace: string; id: string }): SelKey => `${it.workspace}::${it.id}`;

function navigateRefTo(ref: string): string {
  if (ref.includes('/')) {
    const [p, s] = ref.split('/');
    return `/projects/${p}/assignments/${s}`;
  }
  return `/assignments/${ref}`;
}

export function TodosPage() {
  const { data, loading, error, refetch } = useAllTodos();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  useHotkeyScope('list:todos');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [tagFilter, setTagFilter] = useState<string>('');
  const [newTodoText, setNewTodoText] = useState('');
  const [newTodoWorkspace, setNewTodoWorkspace] = useState('_global');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [selectedKeys, setSelectedKeys] = useState<Set<SelKey>>(new Set());
  const [promoteOpen, setPromoteOpen] = useState(false);
  const lastSelectedKeyRef = useRef<SelKey | null>(null);

  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);

  const collapse = useTodoSectionCollapse('all');
  const [draggedKey, setDraggedKey] = useState<SelKey | null>(null);
  const [dropTargetSection, setDropTargetSection] = useState<TodoSectionId | null>(null);
  // The dragstart event's target is the draggable row, not the grabbed child, so
  // record the actual mousedown target to gate drags from interactive controls.
  const dragOriginRef = useRef<EventTarget | null>(null);

  // Load projects for the inferred-project picker.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/projects');
        if (!res.ok) return;
        const list = (await res.json()) as ProjectSummary[];
        if (!cancelled) setProjects(list.filter((p) => !p.archived));
      } catch {
        // non-fatal
      }
    })();
    return () => { cancelled = true; };
  }, []);

  function copyId(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    navigator.clipboard.writeText(id);
    setCopiedId(id);
    setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
  }

  const allItems = useMemo<AggregatedTodo[]>(() => {
    if (!data?.workspaces) return [];
    const items: AggregatedTodo[] = [];
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

  const filtered = useMemo<AggregatedTodo[]>(() => {
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

  // Reset selection on filter change.
  useEffect(() => {
    setSelectedKeys(new Set());
    lastSelectedKeyRef.current = null;
  }, [search, statusFilter, tagFilter]);

  const selectedItems = useMemo(
    () => filtered.filter((i) => selectedKeys.has(keyOf(i))),
    [filtered, selectedKeys],
  );
  const allVisibleSelected = filtered.length > 0 && selectedItems.length === filtered.length;
  const someVisibleSelected = selectedItems.length > 0 && !allVisibleSelected;

  const sharedWorkspace = useMemo(() => {
    if (selectedItems.length === 0) return null;
    const wss = new Set(selectedItems.map((i) => i.workspace));
    return wss.size === 1 ? [...wss][0] : null;
  }, [selectedItems]);

  const inferredProject = useMemo(() => {
    if (!sharedWorkspace || !projects) return undefined;
    // Only auto-fill when EXACTLY one project claims this workspace. Multiple
    // matches are ambiguous and silently picking the first risks mis-routing,
    // so leave the picker empty for the user to disambiguate.
    const matches = projects.filter((p) => p.workspace === sharedWorkspace);
    return matches.length === 1 ? matches[0].slug : undefined;
  }, [sharedWorkspace, projects]);

  const defaultTitle = selectedItems[0]?.description ?? '';

  const aggregateGroups = useMemo(() => {
    if (sharedWorkspace) return null;
    const byWs = new Map<string, string[]>();
    for (const it of selectedItems) {
      if (!byWs.has(it.workspace)) byWs.set(it.workspace, []);
      byWs.get(it.workspace)!.push(it.id);
    }
    return Array.from(byWs, ([workspace, todoIds]) => ({ workspace, todoIds }));
  }, [selectedItems, sharedWorkspace]);

  const promoteScope: PromoteScope = sharedWorkspace
    ? { kind: 'workspace', workspace: sharedWorkspace }
    : { kind: 'aggregate', groups: aggregateGroups ?? [] };

  function toggleOne(item: AggregatedTodo, index: number, e?: React.MouseEvent | React.ChangeEvent) {
    const k = keyOf(item);
    const isShift = !!(e && 'shiftKey' in e && (e as React.MouseEvent).shiftKey);
    // Resolve the anchor by key against the CURRENT rendered order, so collapsing/
    // expanding a section between shift-clicks can't desync the range.
    const anchorIndex = lastSelectedKeyRef.current
      ? renderedOrdered.findIndex((it) => keyOf(it) === lastSelectedKeyRef.current)
      : -1;
    if (isShift && anchorIndex !== -1) {
      const start = Math.min(anchorIndex, index);
      const end = Math.max(anchorIndex, index);
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        for (let i = start; i <= end; i++) {
          const it = renderedOrdered[i];
          if (it) next.add(keyOf(it));
        }
        return next;
      });
    } else {
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        if (next.has(k)) next.delete(k);
        else next.add(k);
        return next;
      });
    }
    lastSelectedKeyRef.current = k;
  }

  function toggleAllVisible() {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const i of filtered) next.delete(keyOf(i));
      } else {
        for (const i of filtered) next.add(keyOf(i));
      }
      return next;
    });
  }

  function clearSelection() {
    setSelectedKeys(new Set());
    lastSelectedKeyRef.current = null;
  }

  function onPromoteDone(result?: PromoteResult | BulkPromoteResult) {
    clearSelection();
    refetch();
    if (result?.assignmentRef) {
      navigate(navigateRefTo(result.assignmentRef));
    }
  }

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

  const NEXT_STATUS: Record<string, string> = {
    open: 'in_progress',
    in_progress: 'completed',
    completed: 'open',
    blocked: 'open',
  };

  function handleCycleStatus(workspace: string, id: string, currentStatus: string) {
    handleStatusChange(workspace, id, NEXT_STATUS[currentStatus] || 'open');
  }

  async function handleStatusChange(workspace: string, id: string, newStatus: string) {
    switch (newStatus) {
      case 'open':
        await reopenTodo(workspace, id);
        break;
      case 'in_progress':
        await startTodo(workspace, id);
        break;
      case 'completed':
        await completeTodo(workspace, id);
        break;
      case 'blocked':
        await blockTodo(workspace, id);
        break;
    }
    refetch();
  }

  async function handleDelete(workspace: string, id: string) {
    await deleteTodo(workspace, id);
    refetch();
  }

  // Group the filtered todos into the three accordion sections. `renderedOrdered`
  // is the flat list of rows actually in the DOM (expanded sections only); it
  // must match what useListSelection / shift-range select index into.
  const sections = groupTodosBySections(filtered);
  const renderedOrdered = sections
    .filter((s) => !collapse.isCollapsed(s.config.id))
    .flatMap((s) => s.items);

  // Hotkey wiring (R5d: Enter cycles status, o is no-op).
  const { hotkeyRowProps } = useListSelection(renderedOrdered, {
    scope: 'list:todos',
    bindO: false,
    onOpen: (todo) => handleCycleStatus(todo.workspace, todo.id, todo.status),
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

  // R3: ?focus=<id> scroll + highlight.
  const [searchParams, setSearchParams] = useSearchParams();
  const focusId = searchParams.get('focus');
  // Expand the section holding a ?focus= target so its row can render (Done is
  // collapsed by default). `collapse` is intentionally omitted from deps.
  useEffect(() => {
    if (!focusId) return;
    const target = allItems.find((i) => i.id === focusId);
    if (!target) return;
    const sectionId = sectionIdForStatus(target.status);
    if (collapse.isCollapsed(sectionId)) collapse.toggle(sectionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, allItems]);
  useEffect(() => {
    if (!focusId) return;
    const node = document.querySelector<HTMLElement>(
      `[data-todo-id="${CSS.escape(focusId)}"]`,
    );
    if (!node) return;
    node.scrollIntoView({ block: 'nearest' });
    node.classList.add('ring-2', 'ring-primary/60');
    const t = window.setTimeout(() => {
      node.classList.remove('ring-2', 'ring-primary/60');
      setSearchParams((prev: URLSearchParams) => {
        const n = new URLSearchParams(prev);
        n.delete('focus');
        return n;
      });
    }, 1500);
    return () => window.clearTimeout(t);
  }, [focusId, renderedOrdered.length, setSearchParams]);

  // --- Native drag-to-change-status (per-row workspace) ---
  const draggedTodo = draggedKey ? filtered.find((i) => keyOf(i) === draggedKey) ?? null : null;

  function handleDragStart(e: DragEvent<HTMLDivElement>, key: SelKey) {
    // Don't start a drag from an interactive control; let those handle clicks.
    // Use the recorded mousedown target — the dragstart target is the row itself.
    const origin = dragOriginRef.current as HTMLElement | null;
    if (origin?.closest(NON_DRAGGABLE_SELECTOR)) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', key);
    setDraggedKey(key);
  }

  function handleDragEnd() {
    setDraggedKey(null);
    setDropTargetSection(null);
  }

  function handleSectionDragOver(e: DragEvent<HTMLElement>, config: TodoSectionConfig) {
    if (!draggedTodo || config.statuses.includes(draggedTodo.status)) return;
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
    const item = draggedTodo;
    handleDragEnd();
    if (!item || config.statuses.includes(item.status)) return;
    handleStatusChange(item.workspace, item.id, config.dropStatus);
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
            ref={searchRef}
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

      {/* Bulk toolbar */}
      {selectedItems.length > 0 ? (
        <div className="surface-panel flex items-center justify-between gap-3 px-3 py-2">
          <span className="text-sm font-medium">
            {selectedItems.length} selected
            {sharedWorkspace ? (
              <span className="ml-2 text-xs text-muted-foreground">
                (from <strong>{sharedWorkspace}</strong>)
              </span>
            ) : (
              <span className="ml-2 text-xs text-muted-foreground">
                across {new Set(selectedItems.map((i) => i.workspace)).size} workspaces
              </span>
            )}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPromoteOpen(true)}
              className="shell-action shell-action--cta"
            >
              Promote to assignment
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
          <span className="text-muted-foreground/60">— shift-click for range select</span>
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
                    const rowIndex = flatIndex;
                    const k = keyOf(item);
                    const selected = selectedKeys.has(k);
                    return (
                      <div
                        key={`${item.workspace}-${item.id}`}
                        draggable
                        data-todo-id={item.id}
                        {...hotkeyRowProps(rowIndex)}
                        onMouseDown={(e) => { dragOriginRef.current = e.target; }}
                        onDragStart={(e) => handleDragStart(e, k)}
                        onDragEnd={handleDragEnd}
                        className={`surface-panel flex items-center gap-3 px-3 py-2 group cursor-grab active:cursor-grabbing hover:bg-foreground/[0.03] transition ${
                          selected ? 'ring-1 ring-foreground/20' : ''
                        } ${draggedKey === k ? 'opacity-50 shadow-lg' : ''}`}
                        onClick={() => handleCycleStatus(item.workspace, item.id, item.status)}
                      >
                        <input
                          type="checkbox"
                          aria-label={`Select todo ${item.id}`}
                          checked={selected}
                          onChange={() => { /* handled via onClick to capture shiftKey */ }}
                          onClick={(e) => { e.stopPropagation(); toggleOne(item, rowIndex, e); }}
                          className="h-4 w-4 cursor-pointer accent-foreground"
                        />
                        <StatusMenu
                          status={item.status as any}
                          onChange={(s) => handleStatusChange(item.workspace, item.id, s)}
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
                          {item.linkedAssignmentRef ? (
                            <Link
                              to={navigateRefTo(item.linkedAssignmentRef)}
                              className="ml-2 inline-flex items-center gap-0.5 rounded-full border border-status-completed-foreground/40 bg-status-completed/30 px-1.5 py-0.5 text-[10px] font-mono text-status-completed-foreground hover:bg-status-completed/50"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <ArrowRight className="h-2.5 w-2.5" />
                              {item.linkedAssignmentRef.includes('/')
                                ? item.linkedAssignmentRef
                                : `oneoff:${item.linkedAssignmentRef.slice(0, 8)}`}
                            </Link>
                          ) : null}
                        </div>
                        <span className="text-xs text-muted-foreground/60 font-mono">
                          {item.workspace !== '_global' && (
                            <Link
                              to={`/w/${item.workspace}/todos`}
                              className="hover:text-foreground transition mr-2"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {item.workspace}
                            </Link>
                          )}
                        </span>
                        {copiedId === item.id ? (
                          <span className="text-xs text-status-completed-foreground flex items-center gap-1">
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
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDelete(item.workspace, item.id); }}
                          className="text-xs text-muted-foreground/40 hover:text-destructive transition opacity-0 group-hover:opacity-100"
                        >
                          delete
                        </button>
                      </div>
                    );
                  })}
              </TodoAccordionSection>
            );
          });
        })()}
      </div>

      <TodoPromoteModal
        open={promoteOpen}
        selectedIds={selectedItems.map((i) => i.id)}
        scope={promoteScope}
        onOpenChange={setPromoteOpen}
        onDone={onPromoteDone}
        defaultProject={inferredProject}
        defaultTitle={defaultTitle}
        allowOneOff
      />
    </div>
  );
}
