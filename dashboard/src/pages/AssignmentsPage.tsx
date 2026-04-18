import { type DragEvent, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Link, useNavigate, useSearchParams, useParams } from 'react-router-dom';
import { ChevronDown, ChevronUp, FolderKanban } from 'lucide-react';
import { CopyButton } from '../components/CopyButton';
import { cn } from '../lib/utils';
import {
  useAssignmentsBoard,
  useWorkspacePrefix,
  type AssignmentBoardItem,
  type AssignmentTransitionAction,
} from '../hooks/useMissions';
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
import { KanbanBoard, type KanbanColumn } from '../components/KanbanBoard';
import { AssignmentTransitionDialog } from '../components/AssignmentTransitionDialog';
import { StatusBadge, STATUS_META, getStatusDescription } from '../components/StatusBadge';
import { transitionNeedsReason } from '../lib/assignments';
import { useStatusConfig, getStatusLabel } from '../hooks/useStatusConfig';
import { useHotkey, useHotkeyScope, useListSelection } from '../hotkeys';

type ViewMode = 'table' | 'list' | 'kanban';
const VALID_VIEWS: ViewMode[] = ['table', 'list', 'kanban'];
type ActivityFilter = 'all' | 'stale' | 'fresh';

type SortField = 'title' | 'status' | 'priority' | 'assignee' | 'dependencies' | 'updated';
type SortDirection = 'asc' | 'desc';

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
  const [searchParams, setSearchParams] = useSearchParams();

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
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [assigneeFilter, setAssigneeFilter] = useState('all');
  const [missionFilter, setMissionFilter] = useState('all');
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>(
    () => normalizeActivityFilter(staleParam),
  );
  const [sortField, setSortField] = useState<SortField>('updated');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [expandedStatuses, setExpandedStatuses] = useState<Set<string>>(
    () => new Set(COLUMNS),
  );
  const [boardItems, setBoardItems] = useState<AssignmentBoardItem[]>([]);
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [transitioningId, setTransitioningId] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTargetStatus, setDropTargetStatus] = useState<string | null>(null);
  const [pendingMove, setPendingMove] = useState<PendingAssignmentMove | null>(null);

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
  }, [activityFilter, setSearchParams, statusFilter]);

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
  const uniqueMissions = useMemo(
    () =>
      Array.from(
        new Map(boardItems.map((a) => [a.missionSlug, a.missionTitle])),
      ).sort(([, a], [, b]) => a.localeCompare(b)),
    [boardItems],
  );

  const filteredItems = useMemo(() => {
    return boardItems.filter((assignment) => {
      if (workspace) {
        if (workspace === '_ungrouped') {
          if (assignment.missionWorkspace !== null) return false;
        } else {
          if (assignment.missionWorkspace !== workspace) return false;
        }
      }
      if (statusFilter !== 'all' && assignment.status !== statusFilter) return false;
      if (priorityFilter !== 'all' && assignment.priority !== priorityFilter) return false;
      if (activityFilter === 'stale' && !isAssignmentStale(assignment.updated)) return false;
      if (activityFilter === 'fresh' && isAssignmentStale(assignment.updated)) return false;
      if (assigneeFilter !== 'all') {
        const val = assignment.assignee ?? '__unassigned__';
        if (val !== assigneeFilter) return false;
      }
      if (missionFilter !== 'all' && assignment.missionSlug !== missionFilter) return false;

      const query = search.trim().toLowerCase();
      if (query) {
        const haystack = `${assignment.title} ${assignment.slug} ${assignment.missionTitle} ${assignment.missionSlug}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }

      return true;
    });
  }, [activityFilter, boardItems, search, statusFilter, priorityFilter, assigneeFilter, missionFilter, workspace]);

  const sortedItems = useMemo(
    () => sortAssignments(filteredItems, sortField, sortDirection),
    [filteredItems, sortField, sortDirection],
  );

  // Flat visible order depends on view. In list/kanban the user sees items grouped by
  // status column (in COLUMNS order); that's the j/k traversal order.
  const { visibleItems, visibleIndexByKey } = useMemo(() => {
    const items =
      view === 'table'
        ? sortedItems
        : COLUMNS.flatMap((status) => filteredItems.filter((it) => it.status === status));
    const byKey = new Map<string, number>();
    items.forEach((it, i) => byKey.set(getAssignmentKey(it), i));
    return { visibleItems: items, visibleIndexByKey: byKey };
  }, [view, sortedItems, filteredItems, COLUMNS]);

  const { hotkeyRowProps } = useListSelection(visibleItems, {
    scope: 'list:assignments',
    onOpen: (assignment) => {
      const assignWs = assignment.missionWorkspace ? `/w/${assignment.missionWorkspace}` : wsPrefix;
      navigate(`${assignWs}/missions/${assignment.missionSlug}/assignments/${assignment.slug}`);
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
      const updated = action
        ? await runAssignmentTransition(item.missionSlug, item.slug, action, reason)
        : await overrideAssignmentStatus(item.missionSlug, item.slug, toColumnId);

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

  function toggleStatus(status: string) {
    setExpandedStatuses((current) => {
      const next = new Set(current);
      if (next.has(status)) {
        next.delete(status);
      } else {
        next.add(status);
      }
      return next;
    });
  }

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('asc');
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
    <div className="space-y-5">

      <FilterBar>
        <SearchInput
          ref={searchRef}
          value={search}
          onChange={setSearch}
          placeholder="Search assignments or missions"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(normalizeStatusFilter(e.target.value))}
          className="editor-input max-w-[180px]"
        >
          <option value="all">All statuses</option>
          {uniqueStatuses.map((s) => (
            <option key={s} value={s}>{COLUMN_LABELS[s] ?? s}</option>
          ))}
        </select>
        <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)} className="editor-input max-w-[180px]">
          <option value="all">All priorities</option>
          {uniquePriorities.map((p) => (
            <option key={p} value={p} className="capitalize">{p}</option>
          ))}
        </select>
        <select value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)} className="editor-input max-w-[180px]">
          <option value="all">All assignees</option>
          {uniqueAssignees.map((a) => (
            <option key={a} value={a}>{a === '__unassigned__' ? 'Unassigned' : a}</option>
          ))}
        </select>
        <select value={missionFilter} onChange={(e) => setMissionFilter(e.target.value)} className="editor-input max-w-[180px]">
          <option value="all">All missions</option>
          {uniqueMissions.map(([slug, title]) => (
            <option key={slug} value={slug}>{title}</option>
          ))}
        </select>
        <select value={activityFilter} onChange={(e) => setActivityFilter(e.target.value as ActivityFilter)} className="editor-input max-w-[180px]">
          <option value="all">All activity</option>
          <option value="stale">Stale only</option>
          <option value="fresh">Fresh only</option>
        </select>
        <ViewToggle
          value={view}
          onChange={(value) => setView(value as ViewMode)}
          options={[
            { value: 'table', label: 'Table' },
            { value: 'list', label: 'List' },
            { value: 'kanban', label: 'Kanban' },
          ]}
        />
      </FilterBar>

      {transitionError ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300">
          {transitionError}
        </div>
      ) : null}

      {data.assignments.length === 0 ? (
        <EmptyState
          title="No assignments yet"
          description="Assignments appear here once missions contain concrete work items."
          actions={
            <Link className="shell-action bg-foreground text-background hover:opacity-90" to={`${wsPrefix}/missions`}>
              <FolderKanban className="h-4 w-4" />
              <span>Browse Missions</span>
            </Link>
          }
        />
      ) : filteredItems.length === 0 ? (
        <EmptyState
          title="No assignments match these filters"
          description="Adjust the search term or filters to show assignments across all missions again."
        />
      ) : view === 'table' ? (
        <SectionCard title={`${sortedItems.length} assignment${sortedItems.length === 1 ? '' : 's'}`}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-border/60 text-muted-foreground">
                  <SortHeader field="title">Assignment</SortHeader>
                  <SortHeader field="status">Status</SortHeader>
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
                        to={`${wsPrefix}/missions/${assignment.missionSlug}/assignments/${assignment.slug}`}
                        className="font-semibold text-foreground hover:text-primary"
                      >
                        {assignment.title}
                      </Link>
                      <p className="mt-1 text-xs text-muted-foreground">{assignment.missionTitle}</p>
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
          {COLUMNS.map((status) => {
            const items = filteredItems.filter((item) => item.status === status);
            if (items.length === 0 && !draggedItem) return null;
            const expanded = expandedStatuses.has(status);
            const isValidTarget = draggedItem
              ? draggedItem.status !== status && !getAssignmentAction(draggedItem, status)?.disabled
              : false;
            const isInvalidTarget = draggedItem ? draggedItem.status !== status && !isValidTarget : false;
            const isDropHover = dropTargetStatus === status;
            return (
              <div
                key={status}
                className={cn(
                  'rounded-lg border border-border/60 bg-card/90 transition',
                  isDropHover && isValidTarget && 'ring-2 ring-ring/30',
                  isInvalidTarget && 'border-dashed opacity-65',
                )}
                onDragOver={(event) => handleDragOver(event, status)}
                onDragLeave={(event) => handleDragLeave(event, status)}
                onDrop={(event) => handleListDrop(event, status)}
              >
                <button
                  type="button"
                  onClick={() => toggleStatus(status)}
                  className="flex w-full items-center gap-2 px-4 py-3 text-left"
                >
                  <ChevronDown
                    className={`h-4 w-4 text-muted-foreground transition-transform ${expanded ? '' : '-rotate-90'}`}
                  />
                  <span className="font-semibold text-foreground">
                    {COLUMN_LABELS[status]}
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
          columns={KANBAN_COLUMNS}
          items={filteredItems}
          getItemId={getAssignmentKey}
          getColumnId={(item) => item.status}
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
          onMove={({ item, toColumnId }) => handleMove({ item, toColumnId })}
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
    </div>
  );
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
    <div className="rounded-lg border border-border/60 bg-background/85 p-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <Link
            to={`${wsPrefix}/missions/${assignment.missionSlug}/assignments/${assignment.slug}`}
            className="text-base font-semibold text-foreground hover:text-primary"
          >
            {assignment.title}
          </Link>
          <p className="text-sm text-muted-foreground">{assignment.missionTitle}</p>
          <p className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground/70" title={assignment.id ?? ''}>
            {assignment.id?.slice(0, 8)}
            {assignment.id && <CopyButton value={assignment.id} />}
          </p>
        </div>
        <StatusBadge status={assignment.status} />
      </div>

      {assignment.blockedReason ? (
        <p className="mt-3 rounded-md border border-amber-200/70 bg-amber-50/80 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/20 dark:text-amber-300">
          {assignment.blockedReason}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
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
