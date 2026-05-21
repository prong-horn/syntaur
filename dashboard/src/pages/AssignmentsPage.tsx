import { type DragEvent, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Link, useNavigate, useSearchParams, useParams } from 'react-router-dom';
import { ChevronDown, ChevronUp, FolderKanban, Plus, Pencil, Trash2, ArrowRightLeft } from 'lucide-react';
import { CopyButton } from '../components/CopyButton';
import { cn } from '../lib/utils';
import {
  useAssignmentsBoard,
  useWorkspacePrefix,
  type AssignmentBoardItem,
  type AssignmentTransitionAction,
} from '../hooks/useProjects';
import { runAssignmentTransition, overrideAssignmentStatus } from '../lib/assignments';
import { getAssignmentColumns } from '../lib/kanban';
import { formatDate } from '../lib/format';
import { SearchInput } from '../components/SearchInput';
import { FilterBar } from '../components/FilterBar';
import { ViewToggle } from '../components/ViewToggle';
import { SectionCard } from '../components/SectionCard';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { KanbanBoard, type KanbanColumn, type ExternalDragData } from '../components/KanbanBoard';
import { AssignmentTransitionDialog } from '../components/AssignmentTransitionDialog';
import { ContextMenuPopover } from '../components/ContextMenuPopover';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { MoveToWorkspaceDialog } from '../components/MoveToWorkspaceDialog';
import type { OverflowMenuItem } from '../components/OverflowMenu';
import { StatusBadge, STATUS_META, getStatusDescription } from '../components/StatusBadge';
import { TypeChip } from '../components/TypeChip';
import { transitionNeedsReason } from '../lib/assignments';
import { useStatusConfig, getStatusLabel } from '../hooks/useStatusConfig';
import { useTypesConfig, getTypeLabel } from '../hooks/useTypesConfig';
import { useHotkey, useHotkeyScope, useListSelection } from '../hotkeys';
import {
  VIEW_MODES,
  GROUPINGS,
  type ViewMode,
  type SortField,
  type SortDirection,
  type Grouping,
  type Activity as ActivityFilter,
  type ProjectViewPrefs,
} from '@shared/view-prefs-schema';
import { fetchViewPrefs, saveGlobalViewPrefs, saveScopeViewPrefs, useViewPrefs } from '../hooks/useViewPrefs';
import { mergeForScope } from '@shared/view-prefs-schema';

const VALID_VIEWS: readonly ViewMode[] = VIEW_MODES;

interface PendingAssignmentMove {
  item: AssignmentBoardItem;
  toColumnId: string;
  action: AssignmentTransitionAction;
}

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function normalizeActivityFilter(value: string | null): ActivityFilter {
  if (value === '1') {
    return 'stale';
  }

  if (value === '0') {
    return 'fresh';
  }

  return 'all';
}

function areSearchParamsEqual(left: URLSearchParams, right: URLSearchParams): boolean {
  return left.toString() === right.toString();
}

function isAssignmentStale(updated: string): boolean {
  const timestamp = Date.parse(updated);
  if (Number.isNaN(timestamp)) {
    return false;
  }

  return Date.now() - timestamp > 7 * 24 * 60 * 60 * 1000;
}

function sortAssignments(
  items: AssignmentBoardItem[],
  field: SortField,
  direction: SortDirection,
): AssignmentBoardItem[] {
  const sorted = [...items].sort((a, b) => {
    let cmp = 0;
    switch (field) {
      case 'title':
        cmp = a.title.localeCompare(b.title);
        break;
      case 'status':
        cmp = a.status.localeCompare(b.status);
        break;
      case 'priority':
        cmp = (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99);
        break;
      case 'assignee':
        cmp = (a.assignee ?? '').localeCompare(b.assignee ?? '');
        break;
      case 'dependencies':
        cmp = a.dependsOn.length - b.dependsOn.length;
        break;
      case 'updated':
        cmp = a.updated.localeCompare(b.updated);
        break;
    }
    return direction === 'asc' ? cmp : -cmp;
  });
  return sorted;
}

export function AssignmentsPage() {
  const { workspace } = useParams<{ workspace?: string }>();
  const wsPrefix = useWorkspacePrefix();
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);
  useHotkeyScope('list:assignments');
  const { data, loading, error, refetch } = useAssignmentsBoard();
  const statusConfig = useStatusConfig();
  const typesConfig = useTypesConfig();
  const [searchParams, setSearchParams] = useSearchParams();

  // Namespace the scope key so workspace-scoped prefs cannot collide with
  // project-detail prefs if a workspace name and a project slug ever match.
  const scope: string | null = workspace ? `w:${workspace}` : null;
  const prefs = useViewPrefs(scope);
  // Tracks which scope the URL has been bootstrapped for. `undefined` = never.
  // Reset implicitly when `scope` changes (we re-bootstrap for the new scope).
  const bootstrappedScopeRef = useRef<string | null | undefined>(undefined);

  const COLUMNS = useMemo(() => getAssignmentColumns(statusConfig.order), [statusConfig]);
  const COLUMN_LABELS = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const id of COLUMNS) {
      labels[id] = getStatusLabel(statusConfig, id);
    }
    return labels;
  }, [COLUMNS, statusConfig]);
  const KANBAN_COLUMNS: KanbanColumn[] = useMemo(
    () => COLUMNS.map((status) => ({
      id: status,
      title: COLUMN_LABELS[status] ?? status,
      description: getStatusDescription(status),
    })),
    [COLUMNS, COLUMN_LABELS],
  );
  const TYPE_KANBAN_COLUMNS: KanbanColumn[] = useMemo(
    () => typesConfig.definitions.map((def) => ({
      id: def.id,
      title: getTypeLabel(typesConfig, def.id),
      description: def.description,
    })),
    [typesConfig],
  );
  const VALID_STATUS_SET = useMemo(() => new Set<string>(['all', ...COLUMNS]), [COLUMNS]);

  const viewParam = searchParams.get('view') as ViewMode | null;
  const statusParam = searchParams.get('status');
  const staleParam = searchParams.get('stale');
  const view: ViewMode = viewParam && VALID_VIEWS.includes(viewParam) ? viewParam : 'kanban';

  function normalizeStatusFilter(value: string | null): string {
    if (!value || !VALID_STATUS_SET.has(value)) return 'all';
    return value;
  }

  const setView = useCallback(
    (v: ViewMode) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (v === 'kanban') {
          next.delete('view');
        } else {
          next.set('view', v);
        }
        return next;
      });
    },
    [setSearchParams],
  );

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>(
    () => normalizeStatusFilter(statusParam),
  );
  const [priorityFilter, setPriorityFilter] = useState<string>(() => prefs.filters.priority ?? 'all');
  const [typeFilter, setTypeFilter] = useState<string>(() => prefs.filters.type ?? 'all');
  const [assigneeFilter, setAssigneeFilter] = useState<string>(() => prefs.filters.assignee ?? 'all');
  const [projectFilter, setProjectFilter] = useState<string>(() => prefs.filters.project ?? 'all');
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>(
    () => normalizeActivityFilter(staleParam),
  );
  const [sortField, setSortField] = useState<SortField>(() => prefs.sortField);
  const [sortDirection, setSortDirection] = useState<SortDirection>(() => prefs.sortDirection);
  const [grouping, setGrouping] = useState<Grouping>(() => prefs.grouping);
  // Tracks group IDs the user has explicitly collapsed. New / unknown group IDs
  // default to expanded so changing the grouping dimension doesn't hide everything.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [boardItems, setBoardItems] = useState<AssignmentBoardItem[]>([]);
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [transitioningId, setTransitioningId] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTargetStatus, setDropTargetStatus] = useState<string | null>(null);
  const [pendingMove, setPendingMove] = useState<PendingAssignmentMove | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    item: AssignmentBoardItem;
    anchor: { x: number; y: number };
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AssignmentBoardItem | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState<AssignmentBoardItem | null>(null);

  useEffect(() => {
    setBoardItems(data?.assignments ?? []);
  }, [data]);

  useEffect(() => {
    const nextStatus = normalizeStatusFilter(statusParam);
    if (nextStatus !== statusFilter) {
      setStatusFilter(nextStatus);
    }

    const nextActivity = normalizeActivityFilter(staleParam);
    if (nextActivity !== activityFilter) {
      setActivityFilter(nextActivity);
    }
  }, [activityFilter, staleParam, statusFilter, statusParam]);

  useEffect(() => {
    // Only mirror state -> URL once bootstrap for the current scope has
    // completed. During scope switches the bootstrap re-runs and this gate
    // re-closes until the new scope's seed is applied.
    if (bootstrappedScopeRef.current !== scope) return;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);

      if (statusFilter === 'all') {
        next.delete('status');
      } else {
        next.set('status', statusFilter);
      }

      if (activityFilter === 'all') {
        next.delete('stale');
      } else if (activityFilter === 'stale') {
        next.set('stale', '1');
      } else {
        next.set('stale', '0');
      }

      return areSearchParamsEqual(prev, next) ? prev : next;
    });
  }, [activityFilter, scope, setSearchParams, statusFilter]);

  // Hydrate non-URL-tracked fields from prefs on every prefs change.
  // Idempotent setX — if local value already matches, React bails out. This
  // covers BOTH the cold-browser case (defaults render first, server response
  // arrives later) AND the Settings-driven case (user changes a default in
  // another component, subscriber-set propagates here).
  useEffect(() => {
    setPriorityFilter(prefs.filters.priority ?? 'all');
    setTypeFilter(prefs.filters.type ?? 'all');
    setAssigneeFilter(prefs.filters.assignee ?? 'all');
    setProjectFilter(prefs.filters.project ?? 'all');
    setSortField(prefs.sortField);
    setSortDirection(prefs.sortDirection);
    setGrouping(prefs.grouping);
  }, [
    prefs.filters.priority,
    prefs.filters.type,
    prefs.filters.assignee,
    prefs.filters.project,
    prefs.sortField,
    prefs.sortDirection,
    prefs.grouping,
  ]);

  // One-shot URL seed PER SCOPE: waits for the server response to land
  // (fetchViewPrefs resolves after the first /api/view-prefs round-trip),
  // then for each URL-tracked field (view / status / stale), writes the
  // persisted value when the URL param is absent. Also hydrates local state
  // for status / activity from the server prefs. Once done, marks the ref
  // with the current scope on next microtask so the state->URL effect unlocks.
  // Re-runs when scope changes (react-router may reuse the component across
  // /w/:workspace/assignments navigations).
  useEffect(() => {
    if (bootstrappedScopeRef.current === scope) return;
    let cancelled = false;
    fetchViewPrefs().then((latest) => {
      if (cancelled || bootstrappedScopeRef.current === scope) return;
      const p = mergeForScope(latest, scope);
      const wantView: ViewMode = p.defaultView;
      const wantStatus = p.filters.status ?? 'all';
      const wantActivity = p.filters.activity ?? 'all';
      // Read the live URL directly. react-router's setSearchParams updates
      // window.location synchronously via the History API, so this is the
      // authoritative current URL even if the React state hasn't propagated
      // through useSearchParams' commit phase yet. Using a ref synchronized
      // in a passive useEffect is too late — the microtask resolving this
      // promise can fire AFTER a state update commits but BEFORE the effect
      // that would refresh the ref runs.
      const currentSP = new URLSearchParams(window.location.search);
      let needsUrlWrite = false;
      const nextParams = new URLSearchParams(currentSP);
      if (currentSP.get('view') === null && wantView !== 'kanban' && VALID_VIEWS.includes(wantView)) {
        nextParams.set('view', wantView);
        needsUrlWrite = true;
      }
      if (currentSP.get('status') === null && wantStatus !== 'all') {
        // Don't pre-validate against VALID_STATUS_SET here — statusConfig is
        // also async and may not be loaded yet. The URL->state effect
        // (normalizeStatusFilter) gracefully reduces unknown values to 'all',
        // and the state->URL effect tidies the URL on the next render.
        nextParams.set('status', wantStatus);
        setStatusFilter(wantStatus);
        needsUrlWrite = true;
      }
      if (currentSP.get('stale') === null && wantActivity !== 'all') {
        nextParams.set('stale', wantActivity === 'stale' ? '1' : '0');
        setActivityFilter(wantActivity);
        needsUrlWrite = true;
      }
      if (needsUrlWrite) {
        setSearchParams(nextParams, { replace: true });
      }
      queueMicrotask(() => {
        bootstrappedScopeRef.current = scope;
      });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  // Persist one field per user action. The server deep-merges, so siblings
  // (other fields, other filter keys) are preserved. Inherited scope fields
  // stay inherited because we never write a value the user didn't touch.
  const persistField = useCallback(
    (patch: ProjectViewPrefs) => {
      const save = scope === null
        ? saveGlobalViewPrefs(patch)
        : saveScopeViewPrefs(scope, patch);
      save.catch((err) => {
        console.warn('Failed to persist view prefs:', err);
      });
    },
    [scope],
  );

  const handleSetView = useCallback(
    (v: ViewMode) => {
      setView(v);
      persistField({ defaultView: v });
    },
    [setView, persistField],
  );
  const handleSetStatusFilter = useCallback(
    (v: string) => {
      setStatusFilter(v);
      persistField({ filters: { status: v } });
    },
    [persistField],
  );
  const handleSetPriorityFilter = useCallback(
    (v: string) => {
      setPriorityFilter(v);
      persistField({ filters: { priority: v } });
    },
    [persistField],
  );
  const handleSetTypeFilter = useCallback(
    (v: string) => {
      setTypeFilter(v);
      persistField({ filters: { type: v } });
    },
    [persistField],
  );
  const handleSetAssigneeFilter = useCallback(
    (v: string) => {
      setAssigneeFilter(v);
      persistField({ filters: { assignee: v } });
    },
    [persistField],
  );
  const handleSetProjectFilter = useCallback(
    (v: string) => {
      setProjectFilter(v);
      persistField({ filters: { project: v } });
    },
    [persistField],
  );
  const handleSetActivityFilter = useCallback(
    (v: ActivityFilter) => {
      setActivityFilter(v);
      persistField({ filters: { activity: v } });
    },
    [persistField],
  );
  const handleSetSortField = useCallback(
    (v: SortField) => {
      setSortField(v);
      persistField({ sortField: v });
    },
    [persistField],
  );
  const handleSetSortDirection = useCallback(
    (v: SortDirection) => {
      setSortDirection(v);
      persistField({ sortDirection: v });
    },
    [persistField],
  );
  const handleSetGrouping = useCallback(
    (v: Grouping) => {
      setGrouping(v);
      persistField({ grouping: v });
    },
    [persistField],
  );

  const uniqueStatuses = useMemo(
    () => Array.from(new Set(boardItems.map((a) => a.status))).sort(),
    [boardItems],
  );
  const uniquePriorities = useMemo(
    () => Array.from(new Set(boardItems.map((a) => a.priority))).sort(),
    [boardItems],
  );
  const uniqueAssignees = useMemo(
    () => Array.from(new Set(boardItems.map((a) => a.assignee ?? '__unassigned__'))).sort(),
    [boardItems],
  );
  const uniqueProjects = useMemo(
    () =>
      Array.from(
        new Map(
          boardItems
            .filter((a): a is typeof a & { projectSlug: string; projectTitle: string } => a.projectSlug !== null)
            .map((a) => [a.projectSlug, a.projectTitle]),
        ),
      ).sort(([, a], [, b]) => a.localeCompare(b)),
    [boardItems],
  );

  const filteredItems = useMemo(() => {
    return boardItems.filter((assignment) => {
      if (workspace) {
        if (workspace === '_ungrouped') {
          if (assignment.projectWorkspace !== null) return false;
        } else {
          if (assignment.projectWorkspace !== workspace) return false;
        }
      }
      if (statusFilter !== 'all' && assignment.status !== statusFilter) return false;
      if (priorityFilter !== 'all' && assignment.priority !== priorityFilter) return false;
      if (typeFilter !== 'all' && (assignment.type ?? '') !== typeFilter) return false;
      if (activityFilter === 'stale' && !isAssignmentStale(assignment.updated)) return false;
      if (activityFilter === 'fresh' && isAssignmentStale(assignment.updated)) return false;
      if (assigneeFilter !== 'all') {
        const val = assignment.assignee ?? '__unassigned__';
        if (val !== assigneeFilter) return false;
      }
      if (projectFilter !== 'all') {
        if (projectFilter === '__standalone__') {
          if (assignment.projectSlug !== null) return false;
        } else if (assignment.projectSlug !== projectFilter) {
          return false;
        }
      }

      const query = search.trim().toLowerCase();
      if (query) {
        const haystack = `${assignment.title} ${assignment.slug} ${assignment.projectTitle ?? 'standalone'} ${assignment.projectSlug ?? ''}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }

      return true;
    });
  }, [activityFilter, boardItems, search, statusFilter, priorityFilter, typeFilter, assigneeFilter, projectFilter, workspace]);

  const sortedItems = useMemo(
    () => sortAssignments(filteredItems, sortField, sortDirection),
    [filteredItems, sortField, sortDirection],
  );

  // Derive list-view groups from prefs.grouping. Status (default) preserves
  // legacy behavior. Type and other dimensions are bucketed dynamically.
  // Each group is { id, label, items } in display order.
  const listGroups = useMemo(() => {
    if (grouping === 'none') {
      return [{ id: '__all__', label: 'All assignments', items: filteredItems }];
    }
    if (grouping === 'type') {
      const groups: { id: string; label: string; items: AssignmentBoardItem[] }[] = typesConfig.definitions.map((def) => ({
        id: def.id,
        label: getTypeLabel(typesConfig, def.id),
        items: filteredItems.filter((it) => it.type === def.id),
      }));
      const knownIds = new Set(typesConfig.definitions.map((d) => d.id));
      const unknown = filteredItems.filter((it) => !it.type || !knownIds.has(it.type));
      if (unknown.length > 0) {
        groups.push({ id: '__unknown_type__', label: 'Other', items: unknown });
      }
      return groups;
    }
    if (grouping === 'priority') {
      const order: AssignmentBoardItem['priority'][] = ['critical', 'high', 'medium', 'low'];
      return order.map((p) => ({
        id: p,
        label: p.charAt(0).toUpperCase() + p.slice(1),
        items: filteredItems.filter((it) => it.priority === p),
      }));
    }
    if (grouping === 'assignee') {
      const assignees = Array.from(new Set(filteredItems.map((it) => it.assignee ?? '__unassigned__'))).sort();
      return assignees.map((a) => ({
        id: a,
        label: a === '__unassigned__' ? 'Unassigned' : a,
        items: filteredItems.filter((it) => (it.assignee ?? '__unassigned__') === a),
      }));
    }
    if (grouping === 'project') {
      const seen = new Map<string, string>();
      for (const it of filteredItems) {
        const key = it.projectSlug ?? '__standalone__';
        const label = it.projectTitle ?? 'Standalone';
        if (!seen.has(key)) seen.set(key, label);
      }
      return Array.from(seen.entries())
        .sort(([, a], [, b]) => a.localeCompare(b))
        .map(([key, label]) => ({
          id: key,
          label,
          items: filteredItems.filter((it) => (it.projectSlug ?? '__standalone__') === key),
        }));
    }
    // Default: status grouping
    return COLUMNS.map((status) => ({
      id: status,
      label: COLUMN_LABELS[status] ?? status,
      items: filteredItems.filter((it) => it.status === status),
    }));
  }, [grouping, filteredItems, typesConfig, COLUMNS, COLUMN_LABELS]);

  // Flat visible order depends on view. In list/kanban the user sees items grouped by
  // the active grouping; that's the j/k traversal order.
  const { visibleItems, visibleIndexByKey } = useMemo(() => {
    const items =
      view === 'table'
        ? sortedItems
        : listGroups.flatMap((g) => g.items);
    const byKey = new Map<string, number>();
    items.forEach((it, i) => byKey.set(getAssignmentKey(it), i));
    return { visibleItems: items, visibleIndexByKey: byKey };
  }, [view, sortedItems, listGroups]);

  const { hotkeyRowProps } = useListSelection(visibleItems, {
    scope: 'list:assignments',
    onOpen: (assignment) => {
      if (assignment.projectSlug === null) {
        navigate(`/assignments/${assignment.id}`);
        return;
      }
      const assignWs = assignment.projectWorkspace ? `/w/${assignment.projectWorkspace}` : wsPrefix;
      navigate(`${assignWs}/projects/${assignment.projectSlug}/assignments/${assignment.slug}`);
    },
  });
  useHotkey({
    keys: '/',
    scope: 'list:assignments',
    description: 'Focus filter',
    handler: () => searchRef.current?.focus(),
  });
  useHotkey({
    keys: 'r',
    scope: 'list:assignments',
    description: 'Refresh',
    handler: () => refetch(),
  });

  if (loading) {
    return <LoadingState label="Loading assignments board…" />;
  }

  if (error || !data) {
    return <ErrorState error={error || 'Assignments board is unavailable.'} />;
  }

  async function applyMove({
    item,
    toColumnId,
    action,
    reason,
  }: {
    item: AssignmentBoardItem;
    toColumnId: string;
    action?: AssignmentTransitionAction;
    reason?: string;
  }) {
    setTransitionError(null);
    setTransitioningId(getAssignmentKey(item));

    const previous = boardItems;
    setBoardItems((current) =>
      current.map((candidate) =>
        getAssignmentKey(candidate) === getAssignmentKey(item)
          ? {
              ...candidate,
              status: toColumnId,
              blockedReason: toColumnId === 'blocked' ? reason ?? candidate.blockedReason : null,
            }
          : candidate,
      ),
    );

    try {
      if (item.projectSlug === null) {
        // Standalone: use by-id route directly. Skip override (not implemented for standalone).
        if (!action) throw new Error('Standalone assignments require a transition action, not status override.');
        const res = await fetch(
          `/api/assignments/${encodeURIComponent(item.id)}/transitions/${encodeURIComponent(action.command)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(reason ? { reason } : {}),
          },
        );
        if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
        const payload = await res.json();
        const updated = payload.assignment;
        setBoardItems((current) =>
          current.map((candidate) =>
            getAssignmentKey(candidate) === getAssignmentKey(item)
              ? { ...candidate, status: updated.status, blockedReason: updated.blockedReason, availableTransitions: updated.availableTransitions, updated: updated.updated }
              : candidate,
          ),
        );
        return;
      }
      const updated = action
        ? await runAssignmentTransition(item.projectSlug, item.slug, action, reason)
        : await overrideAssignmentStatus(item.projectSlug, item.slug, toColumnId);

      setBoardItems((current) =>
        current.map((candidate) =>
          getAssignmentKey(candidate) === getAssignmentKey(item)
            ? {
                ...candidate,
                status: updated.status,
                blockedReason: updated.blockedReason,
                availableTransitions: updated.availableTransitions,
                updated: updated.updated,
              }
            : candidate,
        ),
      );
      refetch();
      return true;
    } catch (mutationError) {
      setBoardItems(previous);
      setTransitionError((mutationError as Error).message);
      return false;
    } finally {
      setTransitioningId(null);
    }
  }

  async function handleMove({
    item,
    toColumnId,
  }: {
    item: AssignmentBoardItem;
    toColumnId: string;
  }) {
    if (item.status === toColumnId) {
      return;
    }

    const action = getAssignmentAction(item, toColumnId);
    if (action?.disabled) {
      setTransitionError(action.disabledReason || `Cannot move this assignment to ${toColumnId}.`);
      return;
    }

    if (action && transitionNeedsReason(action)) {
      setPendingMove({ item, toColumnId, action });
      return;
    }

    await applyMove({ item, toColumnId, action });
  }

  function toggleGroup(groupId: string) {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }

  function handleSort(field: SortField) {
    if (sortField === field) {
      const next: SortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      handleSetSortDirection(next);
    } else {
      handleSetSortField(field);
      handleSetSortDirection('asc');
    }
  }

  const draggedItem = draggedId
    ? boardItems.find((item) => getAssignmentKey(item) === draggedId) ?? null
    : null;

  function handleDragStart(event: DragEvent<HTMLDivElement>, itemId: string) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', itemId);
    setDraggedId(itemId);
  }

  function handleDragEnd() {
    setDraggedId(null);
    setDropTargetStatus(null);
  }

  function handleDragOver(event: DragEvent<HTMLElement>, status: string) {
    if (!draggedItem) return;
    const action = getAssignmentAction(draggedItem, status);
    if (draggedItem.status === status || action?.disabled) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTargetStatus(status);
  }

  function handleDragLeave(event: DragEvent<HTMLElement>, status: string) {
    if (dropTargetStatus === status && !event.currentTarget.contains(event.relatedTarget as Node)) {
      setDropTargetStatus(null);
    }
  }

  function handleListDrop(event: DragEvent<HTMLElement>, status: string) {
    event.preventDefault();
    if (!draggedItem || draggedItem.status === status) {
      handleDragEnd();
      return;
    }
    handleDragEnd();
    handleMove({ item: draggedItem, toColumnId: status });
  }

  function SortHeader({ field, children }: { field: SortField; children: React.ReactNode }) {
    const active = sortField === field;
    return (
      <th className="pb-3 font-medium">
        <button
          type="button"
          onClick={() => handleSort(field)}
          className="inline-flex items-center gap-1 hover:text-foreground"
        >
          {children}
          {active ? (
            sortDirection === 'asc' ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )
          ) : null}
        </button>
      </th>
    );
  }

  return (
    <div className="space-y-5" data-density={prefs.density}>
      <div className="flex items-center justify-end">
        <Link
          to={`${wsPrefix}/assignments/new`}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-foreground px-3 text-sm font-medium text-background transition hover:bg-foreground/90"
        >
          <Plus className="h-4 w-4" />
          New Assignment
        </Link>
      </div>

      <FilterBar>
        <SearchInput
          ref={searchRef}
          value={search}
          onChange={setSearch}
          placeholder="Search assignments or projects"
        />
        <select
          value={statusFilter}
          onChange={(e) => handleSetStatusFilter(normalizeStatusFilter(e.target.value))}
          className="editor-input max-w-[180px]"
        >
          <option value="all">All statuses</option>
          {uniqueStatuses.map((s) => (
            <option key={s} value={s}>{COLUMN_LABELS[s] ?? s}</option>
          ))}
        </select>
        <select value={priorityFilter} onChange={(e) => handleSetPriorityFilter(e.target.value)} className="editor-input max-w-[180px]">
          <option value="all">All priorities</option>
          {uniquePriorities.map((p) => (
            <option key={p} value={p} className="capitalize">{p}</option>
          ))}
        </select>
        <select value={typeFilter} onChange={(e) => handleSetTypeFilter(e.target.value)} className="editor-input max-w-[180px]">
          <option value="all">All types</option>
          {typesConfig.definitions.map((t) => (
            <option key={t.id} value={t.id}>{getTypeLabel(typesConfig, t.id)}</option>
          ))}
        </select>
        <select value={assigneeFilter} onChange={(e) => handleSetAssigneeFilter(e.target.value)} className="editor-input max-w-[180px]">
          <option value="all">All assignees</option>
          {uniqueAssignees.map((a) => (
            <option key={a} value={a}>{a === '__unassigned__' ? 'Unassigned' : a}</option>
          ))}
        </select>
        <select value={projectFilter} onChange={(e) => handleSetProjectFilter(e.target.value)} className="editor-input max-w-[180px]">
          <option value="all">All projects</option>
          <option value="__standalone__">Standalone</option>
          {uniqueProjects.map(([slug, title]) => (
            <option key={slug} value={slug}>{title}</option>
          ))}
        </select>
        <select value={activityFilter} onChange={(e) => handleSetActivityFilter(e.target.value as ActivityFilter)} className="editor-input max-w-[180px]">
          <option value="all">All activity</option>
          <option value="stale">Stale only</option>
          <option value="fresh">Fresh only</option>
        </select>
        <select value={grouping} onChange={(e) => handleSetGrouping(e.target.value as Grouping)} className="editor-input max-w-[180px]" title="Group by">
          {GROUPINGS.map((g) => (
            <option key={g} value={g}>{g === 'none' ? 'No grouping' : `Group: ${g.charAt(0).toUpperCase() + g.slice(1)}`}</option>
          ))}
        </select>
        <ViewToggle
          value={view}
          onChange={(value) => handleSetView(value as ViewMode)}
          options={[
            { value: 'table', label: 'Table' },
            { value: 'list', label: 'List' },
            { value: 'kanban', label: 'Kanban' },
          ]}
        />
      </FilterBar>

      {transitionError ? (
        <div className="rounded-md border border-error-foreground/30 bg-error px-4 py-3 text-sm text-error-foreground">
          {transitionError}
        </div>
      ) : null}

      {data.assignments.length === 0 ? (
        <EmptyState
          title="No assignments yet"
          description="Assignments appear here once projects contain concrete work items."
          actions={
            <Link className="shell-action bg-foreground text-background hover:opacity-90" to={`${wsPrefix}/projects`}>
              <FolderKanban className="h-4 w-4" />
              <span>Browse Projects</span>
            </Link>
          }
        />
      ) : filteredItems.length === 0 ? (
        <EmptyState
          title="No assignments match these filters"
          description="Adjust the search term or filters to show assignments across all projects again."
        />
      ) : view === 'table' ? (
        <SectionCard title={`${sortedItems.length} assignment${sortedItems.length === 1 ? '' : 's'}`}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-border/60 text-muted-foreground">
                  <SortHeader field="title">Assignment</SortHeader>
                  <SortHeader field="status">Status</SortHeader>
                  <th className="py-2 pr-4 text-xs font-medium uppercase tracking-wider">Type</th>
                  <SortHeader field="priority">Priority</SortHeader>
                  <SortHeader field="assignee">Assignee</SortHeader>
                  <SortHeader field="dependencies">Dependencies</SortHeader>
                  <SortHeader field="updated">Updated</SortHeader>
                </tr>
              </thead>
              <tbody>
                {sortedItems.map((assignment, i) => (
                  <tr
                    key={getAssignmentKey(assignment)}
                    className="border-b border-border/50 last:border-0"
                    {...hotkeyRowProps(i)}
                  >
                    <td className="py-4 pr-4">
                      <Link
                        to={
                          assignment.projectSlug === null
                            ? `/assignments/${assignment.id}`
                            : `${wsPrefix}/projects/${assignment.projectSlug}/assignments/${assignment.slug}`
                        }
                        className="font-semibold text-foreground hover:text-primary"
                      >
                        {assignment.title}
                      </Link>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {assignment.projectTitle ?? (
                          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
                            Standalone
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground/70" title={assignment.id}>
                        {assignment.id.slice(0, 8)}
                        <CopyButton value={assignment.id} />
                      </p>
                    </td>
                    <td className="py-4 pr-4">
                      <select
                        value={assignment.status}
                        disabled={transitioningId === getAssignmentKey(assignment)}
                        onChange={(e) =>
                          handleMove({ item: assignment, toColumnId: e.target.value })
                        }
                        className={cn(
                          'appearance-none rounded-full border px-2.5 py-0.5 text-xs font-semibold tracking-wide outline-none',
                          'cursor-pointer bg-[length:12px] bg-[right_6px_center] bg-no-repeat pr-6',
                          "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='currentColor'%3E%3Cpath fill-rule='evenodd' d='M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z'/%3E%3C/svg%3E\")]",
                          (STATUS_META[assignment.status as keyof typeof STATUS_META] ?? STATUS_META.pending).className,
                          transitioningId === getAssignmentKey(assignment) && 'animate-pulse opacity-60',
                        )}
                      >
                        {COLUMNS.map((targetStatus) => {
                          const action = assignment.status === targetStatus
                            ? undefined
                            : getAssignmentAction(assignment, targetStatus);
                          const disabled = action?.disabled ?? false;
                          return (
                            <option
                              key={targetStatus}
                              value={targetStatus}
                              disabled={disabled}
                              title={disabled ? action?.disabledReason ?? undefined : undefined}
                            >
                              {COLUMN_LABELS[targetStatus]}
                            </option>
                          );
                        })}
                      </select>
                    </td>
                    <td className="py-4 pr-4">
                      <TypeChip type={assignment.type} compact />
                    </td>
                    <td className="py-4 pr-4 capitalize text-muted-foreground">{assignment.priority}</td>
                    <td className="py-4 pr-4 text-muted-foreground">{assignment.assignee ?? 'Unassigned'}</td>
                    <td className="py-4 pr-4 text-muted-foreground">{assignment.dependsOn.length}</td>
                    <td className="py-4 text-muted-foreground">{formatDate(assignment.updated)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      ) : view === 'list' ? (
        <div className="space-y-3">
          {listGroups.map(({ id: groupId, label, items }) => {
            if (items.length === 0 && !(draggedItem && grouping === 'status')) return null;
            const expanded = !collapsedGroups.has(groupId);
            const isStatusGroup = grouping === 'status';
            const isValidTarget =
              isStatusGroup && draggedItem
                ? draggedItem.status !== groupId && !getAssignmentAction(draggedItem, groupId)?.disabled
                : false;
            const isInvalidTarget =
              isStatusGroup && draggedItem ? draggedItem.status !== groupId && !isValidTarget : false;
            const isDropHover = isStatusGroup && dropTargetStatus === groupId;
            return (
              <div
                key={groupId}
                className={cn(
                  'rounded-lg border border-border/60 bg-card/90 transition',
                  isDropHover && isValidTarget && 'ring-2 ring-ring/30',
                  isInvalidTarget && 'border-dashed opacity-65',
                )}
                onDragOver={isStatusGroup ? (event) => handleDragOver(event, groupId) : undefined}
                onDragLeave={isStatusGroup ? (event) => handleDragLeave(event, groupId) : undefined}
                onDrop={isStatusGroup ? (event) => handleListDrop(event, groupId) : undefined}
              >
                <button
                  type="button"
                  onClick={() => toggleGroup(groupId)}
                  className="flex w-full items-center gap-2 px-4 py-3 text-left"
                >
                  <ChevronDown
                    className={`h-4 w-4 text-muted-foreground transition-transform ${expanded ? '' : '-rotate-90'}`}
                  />
                  <span className="font-semibold text-foreground">
                    {label}
                  </span>
                  <span className="rounded-full border border-border/60 px-2 py-0.5 text-xs text-muted-foreground">
                    {items.length}
                  </span>
                </button>
                {expanded && items.length > 0 && (
                  <div className="space-y-3 px-4 pb-4">
                    {items.map((item) => {
                      const itemKey = getAssignmentKey(item);
                      const isDragging = draggedId === itemKey;
                      const flatIdx = visibleIndexByKey.get(itemKey) ?? -1;
                      return (
                        <div
                          key={itemKey}
                          draggable
                          onDragStart={(event) => handleDragStart(event, itemKey)}
                          onDragEnd={handleDragEnd}
                          {...(flatIdx >= 0 ? hotkeyRowProps(flatIdx) : {})}
                          className={cn(
                            'cursor-grab transition active:cursor-grabbing',
                            isDragging && 'scale-[0.98] opacity-50',
                          )}
                        >
                          <AssignmentBoardCard
                            assignment={item}
                            dragging={isDragging}
                            transitioning={transitioningId === itemKey}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <KanbanBoard
          columns={grouping === 'type' ? TYPE_KANBAN_COLUMNS : KANBAN_COLUMNS}
          items={filteredItems}
          getItemId={getAssignmentKey}
          getColumnId={(item) =>
            grouping === 'type'
              ? (item.type && typesConfig.definitions.some((d) => d.id === item.type)
                  ? item.type
                  : typesConfig.default)
              : item.status
          }
          canDrop={({ item, fromColumnId, toColumnId }) => {
            if (fromColumnId === toColumnId) {
              return { allowed: true };
            }

            const action = getAssignmentAction(item, toColumnId);
            if (action?.disabled) {
              return { allowed: false, reason: action.disabledReason || action.description };
            }

            return {
              allowed: true,
              reason: action
                ? (action.warning || action.description)
                : `Move to ${toColumnId} (direct status change).`,
            };
          }}
          onMove={grouping === 'type' ? undefined : ({ item, toColumnId }) => handleMove({ item, toColumnId })}
          dragDisabled={grouping === 'type'}
          getExternalDragData={(item): ExternalDragData | null =>
            item.projectSlug === null
              ? { type: 'standalone-assignment', id: item.id }
              : { type: 'project-assignment', id: item.id }
          }
          onCardContextMenu={(item, event) => {
            event.preventDefault();
            setContextMenu({ item, anchor: { x: event.clientX, y: event.clientY } });
          }}
          emptyMessage={(column) => `No ${column.title.toLowerCase()} assignments.`}
          renderCard={(item, { dragging }) => {
            const flatIdx = visibleIndexByKey.get(getAssignmentKey(item)) ?? -1;
            return (
              <div {...(flatIdx >= 0 ? hotkeyRowProps(flatIdx) : {})}>
                <AssignmentBoardCard
                  assignment={item}
                  dragging={dragging}
                  transitioning={transitioningId === getAssignmentKey(item)}
                />
              </div>
            );
          }}
        />
      )}

      <AssignmentTransitionDialog
        open={pendingMove !== null}
        action={pendingMove?.action ?? null}
        assignmentTitle={pendingMove?.item.title ?? 'Assignment'}
        loading={transitioningId === (pendingMove ? getAssignmentKey(pendingMove.item) : null)}
        onOpenChange={(open) => {
          if (!open) {
            setPendingMove(null);
          }
        }}
        onConfirm={async (reason) => {
          if (!pendingMove) {
            return;
          }

          const move = pendingMove;
          const succeeded = await applyMove({
            item: move.item,
            toColumnId: move.toColumnId,
            action: move.action,
            reason,
          });

          if (succeeded) {
            setPendingMove(null);
          }
        }}
      />

      <ContextMenuPopover
        anchor={contextMenu?.anchor ?? null}
        items={contextMenu ? buildAssignmentContextMenu(contextMenu.item, {
          wsPrefix,
          onEdit: () => {
            const item = contextMenu.item;
            const href =
              item.projectSlug === null
                ? `/assignments/${item.id}`
                : `${item.projectWorkspace ? `/w/${item.projectWorkspace}` : wsPrefix}/projects/${item.projectSlug}/assignments/${item.slug}`;
            navigate(href);
          },
          onDelete: () => setDeleteTarget(contextMenu.item),
          onMove: () => setMoveTarget(contextMenu.item),
        }) : []}
        onClose={() => setContextMenu(null)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete assignment?"
        description={
          deleteTarget
            ? `"${deleteTarget.title}" will be permanently removed. This cannot be undone.`
            : ''
        }
        confirmLabel="Delete"
        destructive
        loading={deletingKey !== null}
        onOpenChange={(next) => {
          if (!next && deletingKey === null) setDeleteTarget(null);
        }}
        onConfirm={async () => {
          if (!deleteTarget || deleteTarget.projectSlug === null) {
            setDeleteTarget(null);
            return;
          }
          const key = getAssignmentKey(deleteTarget);
          setDeletingKey(key);
          try {
            const res = await fetch(
              `/api/projects/${encodeURIComponent(deleteTarget.projectSlug)}/assignments/${encodeURIComponent(deleteTarget.slug)}`,
              { method: 'DELETE' },
            );
            if (!res.ok) {
              const body = await res.json().catch(() => ({}));
              throw new Error(body.error || 'Failed to delete assignment');
            }
            setDeleteTarget(null);
            refetch();
          } catch (err) {
            alert(err instanceof Error ? err.message : 'Failed to delete assignment');
          } finally {
            setDeletingKey(null);
          }
        }}
      />

      <MoveToWorkspaceDialog
        open={moveTarget !== null}
        onOpenChange={(next) => {
          if (!next) setMoveTarget(null);
        }}
        currentWorkspace={moveTarget?.projectWorkspace ?? null}
        title="Move assignment to workspace"
        description="Standalone assignments belong to a project-workspace via the workspaceGroup frontmatter field."
        onSubmit={async (target) => {
          if (!moveTarget) return;
          const res = await fetch(`/api/assignments/${encodeURIComponent(moveTarget.id)}/move-workspace`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceGroup: target }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || 'Failed to move assignment');
          }
          refetch();
        }}
      />
    </div>
  );
}

function buildAssignmentContextMenu(
  item: AssignmentBoardItem,
  handlers: { wsPrefix: string; onEdit: () => void; onDelete: () => void; onMove: () => void },
): OverflowMenuItem[] {
  const items: OverflowMenuItem[] = [
    { key: 'edit', label: 'Edit', icon: Pencil, onSelect: handlers.onEdit },
  ];
  if (item.projectSlug !== null) {
    // Project-scoped: delete is wired to the existing nested DELETE route.
    items.push({
      key: 'delete',
      label: 'Delete',
      icon: Trash2,
      destructive: true,
      onSelect: handlers.onDelete,
    });
    // Move is omitted: project-scoped assignments inherit their workspace from
    // the parent project. The server enforces this with a 400.
  } else {
    // Standalone: no DELETE /api/assignments/:id route yet, so omit Delete.
    items.push({
      key: 'move',
      label: 'Move to workspace…',
      icon: ArrowRightLeft,
      onSelect: handlers.onMove,
    });
  }
  return items;
}

function AssignmentBoardCard({
  assignment,
  dragging,
  transitioning,
}: {
  assignment: AssignmentBoardItem;
  dragging: boolean;
  transitioning: boolean;
}) {
  const wsPrefix = useWorkspacePrefix();
  return (
    <div className="vp-card rounded-lg border border-border/60 bg-background/85 p-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <Link
            to={
              assignment.projectSlug === null
                ? `/assignments/${assignment.id}`
                : `${wsPrefix}/projects/${assignment.projectSlug}/assignments/${assignment.slug}`
            }
            className="text-base font-semibold text-foreground hover:text-primary"
          >
            {assignment.title}
          </Link>
          <p className="text-sm text-muted-foreground">
            {assignment.projectTitle ?? (
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
                Standalone
              </span>
            )}
          </p>
          <p className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground/70" title={assignment.id ?? ''}>
            {assignment.id?.slice(0, 8)}
            {assignment.id && <CopyButton value={assignment.id} />}
          </p>
        </div>
        <StatusBadge status={assignment.status} />
      </div>

      {assignment.blockedReason ? (
        <p className="mt-3 rounded-md border border-warning-foreground/30 bg-warning px-3 py-2 text-sm text-warning-foreground">
          {assignment.blockedReason}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <TypeChip type={assignment.type} />
        <span className="rounded-full border border-border/60 px-2.5 py-1 text-xs capitalize text-muted-foreground">
          {assignment.priority}
        </span>
        <span className="rounded-full border border-border/60 px-2.5 py-1 text-xs text-muted-foreground">
          {assignment.assignee ?? 'Unassigned'}
        </span>
        <span className="rounded-full border border-border/60 px-2.5 py-1 text-xs text-muted-foreground">
          {assignment.dependsOn.length} dependencies
        </span>
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 text-xs uppercase tracking-[0.08em] text-muted-foreground">
        <span>{transitioning ? 'Updating' : dragging ? 'Dragging' : 'Source-first'}</span>
        <span>{formatDate(assignment.updated)}</span>
      </div>
    </div>
  );
}

function getAssignmentAction(
  assignment: AssignmentBoardItem,
  targetStatus: string,
): AssignmentTransitionAction | undefined {
  return assignment.availableTransitions.find((action) => action.targetStatus === targetStatus);
}

function getAssignmentKey(assignment: Pick<AssignmentBoardItem, 'id' | 'slug'>): string {
  return assignment.id || assignment.slug || 'unknown';
}
