import { type DragEvent, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Link, useNavigate, useSearchParams, useParams } from 'react-router-dom';
import { ChevronDown, ChevronUp, FilterX, FolderKanban, Plus, Pencil, Trash2, ArrowRightLeft } from 'lucide-react';
import { CopyButton } from '../components/CopyButton';
import { cn } from '../lib/utils';
import {
  useAssignmentsBoard,
  useWorkspacePrefix,
  type AssignmentBoardItem,
  type AssignmentTransitionAction,
} from '../hooks/useProjects';
import {
  runAssignmentTransition,
  runAssignmentTransitionById,
  overrideAssignmentStatus,
  overrideAssignmentStatusById,
  updateAssignmentTitle,
  updateAssignmentTitleById,
} from '../lib/assignments';
import { deriveStatusOptions, isTerminalStatus, resolveStatusAppearance } from '../lib/statusMeta';
import { getAssignmentColumns } from '../lib/kanban';
import { sortAssignments } from '../lib/sortAssignments';
import { formatDate } from '../lib/format';
import { assignmentDetailHref } from '../lib/assignmentFilter';
import { SearchInput } from '../components/SearchInput';
import { FilterBar } from '../components/FilterBar';
import { ViewToggle } from '../components/ViewToggle';
import { TableColumnPicker } from '../components/TableColumnPicker';
import { SaveViewDialog } from '../components/SaveViewDialog';
import { SavedViewPicker } from '../components/SavedViewPicker';
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
import { StatusBadge, getStatusDescription } from '../components/StatusBadge';
import { TypeChip } from '../components/TypeChip';
import { StatusPillPicker, type StatusOverrideTarget } from '../components/StatusPillPicker';
import { InlineTitleEditor } from '../components/InlineTitleEditor';
import { useBodyClickNavigation } from '../hooks/useBodyClickNavigation';
import { useToast, Toaster } from '../components/Toast';
import { transitionNeedsReason } from '../lib/assignments';
import { useStatusConfig, getStatusLabel } from '../hooks/useStatusConfig';
import { useTypesConfig, getTypeLabel } from '../hooks/useTypesConfig';
import { useHotkey, useHotkeyScope, useListSelection } from '../hotkeys';
import {
  VIEW_MODES,
  GROUPINGS,
  toFilterValues,
  sameFilterValues,
  type ViewMode,
  type SortField,
  type SortDirection,
  type Grouping,
  type Activity as ActivityFilter,
  type ProjectViewPrefs,
} from '@shared/view-prefs-schema';
import { type TableColumnId, type SavedView, type ViewScope } from '@shared/saved-views-schema';
import { fetchViewPrefs, saveGlobalViewPrefs, saveScopeViewPrefs, useViewPrefs } from '../hooks/useViewPrefs';
import { mergeForScope } from '@shared/view-prefs-schema';
import { useSavedView, createSavedView, updateSavedView } from '../hooks/useSavedViews';
import { captureCurrentView, applyConfig, mergeUpdatedConfig, minimizeDateRange, expandDateRange, type DateRangeUiState } from '../lib/savedViews';
import { MultiSelect } from '../components/ui/MultiSelect';
import { DateRangeControl } from '../components/ui/DateRangeControl';
import { QueryInput } from '../components/QueryInput';
import { filterBoardItems } from '../lib/queryFilter';
import { buildQueryRegistry } from '@shared/fact-registry';
import { compileQuery } from '@shared/query';
import { viewFiltersToQuery, queryToViewFilters } from '@shared/view-filters-query';
import type { ViewFilters } from '@shared/saved-views-schema';

const VALID_VIEWS: readonly ViewMode[] = VIEW_MODES;

interface PendingAssignmentMove {
  item: AssignmentBoardItem;
  toColumnId: string;
  action: AssignmentTransitionAction;
}

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
  const UNKNOWN_TYPE_COLUMN_ID = '__unknown_type__';
  const VALID_STATUS_SET = useMemo(() => new Set<string>(['all', ...COLUMNS]), [COLUMNS]);

  const viewParam = searchParams.get('view') as ViewMode | null;
  const statusParam = searchParams.get('status');
  const staleParam = searchParams.get('stale');
  const view: ViewMode = viewParam && VALID_VIEWS.includes(viewParam) ? viewParam : 'kanban';

  // Multi-value status URL param: comma-separated, keep only known status ids
  // (statusConfig is async — unknowns drop gracefully, mirroring the single-value
  // normalizeStatusFilter behavior), dedupe. `?status=blocked` still parses to
  // ['blocked']; `?status=in_progress,review` to both.
  function parseStatusParam(value: string | null): string[] {
    if (!value) return [];
    const out: string[] = [];
    for (const raw of value.split(',')) {
      const s = raw.trim();
      if (!s || s === 'all' || !VALID_STATUS_SET.has(s)) continue;
      if (!out.includes(s)) out.push(s);
    }
    return out;
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
  const [statusFilter, setStatusFilter] = useState<string[]>(
    () => parseStatusParam(statusParam),
  );
  const [priorityFilter, setPriorityFilter] = useState<string[]>(() => toFilterValues(prefs.filters.priority));
  const [typeFilter, setTypeFilter] = useState<string[]>(() => toFilterValues(prefs.filters.type));
  const [assigneeFilter, setAssigneeFilter] = useState<string[]>(() => toFilterValues(prefs.filters.assignee));
  const [projectFilter, setProjectFilter] = useState<string[]>(() => toFilterValues(prefs.filters.project));
  const [tagsFilter, setTagsFilter] = useState<string[]>(() => toFilterValues(prefs.filters.tags));
  // dateRange is a saved-view-only filter (ephemeral board state, not persisted to view-prefs).
  const [dateRange, setDateRange] = useState<DateRangeUiState | null>(null);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>(
    () => normalizeActivityFilter(staleParam),
  );
  // Canonical AQL query — the single filter actually applied to the board. The
  // chip states above are a bidirectional VISUAL EDITOR over the chip-representable
  // subset of this query. Seeded from the initial chip state so the very first
  // render (before any chip change) already filters by the URL-seeded chips.
  const [query, setQuery] = useState<string>(() =>
    viewFiltersToQuery({
      status: parseStatusParam(statusParam),
      priority: toFilterValues(prefs.filters.priority),
      type: toFilterValues(prefs.filters.type),
      assignee: toFilterValues(prefs.filters.assignee),
      project: toFilterValues(prefs.filters.project),
      tags: toFilterValues(prefs.filters.tags),
      activity: normalizeActivityFilter(staleParam),
    }),
  );
  const [sortField, setSortField] = useState<SortField>(() => prefs.sortField);
  const [sortDirection, setSortDirection] = useState<SortDirection>(() => prefs.sortDirection);
  // Kanban column visibility — default empty (all columns shown).
  const [kanbanColumnVisibility, setKanbanColumnVisibility] = useState<{ hidden: string[] }>(
    () => ({ hidden: [] }),
  );
  // Table column visibility — default empty (all columns shown).
  const [tableColumnVisibility, setTableColumnVisibility] = useState<{ hidden: TableColumnId[] }>(
    () => ({ hidden: [] }),
  );
  const [grouping, setGrouping] = useState<Grouping>(() => prefs.grouping);
  // Kanban only supports status / type grouping; any other persisted value
  // (set from list view) is rendered as status. The dropdown reflects this
  // coerced value when view === 'kanban' so the UI never disagrees with what
  // the board actually shows. Persisted value survives the view switch.
  const effectiveKanbanGrouping: 'status' | 'type' = grouping === 'type' ? 'type' : 'status';
  // Tracks group IDs the user has explicitly collapsed, keyed by the active
  // grouping's group id. Persisted via saved views: buildViewState derives the
  // serializable `listSectionVisibility` from this set, and applyConfig seeds it
  // back. New / unknown group IDs default to expanded.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [boardItems, setBoardItems] = useState<AssignmentBoardItem[]>([]);
  const { toast, showToast, dismissToast } = useToast();
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
  const [loadedViewId, setLoadedViewId] = useState<string | null>(null);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveAsNewMode, setSaveAsNewMode] = useState(false);

  const viewScope: ViewScope = workspace
    ? { kind: 'workspace', workspace }
    : { kind: 'global' };

  const loadViewParam = searchParams.get('loadView');
  const { view: pendingView, loading: pendingViewLoading, error: pendingViewError } = useSavedView(
    loadViewParam,
  );
  const { view: loadedView, loading: loadedViewLoading, error: loadedViewError } = useSavedView(loadedViewId);
  // Track the last id we already applied so we don't double-apply on re-render.
  const lastAppliedLoadViewRef = useRef<string | null>(null);

  useEffect(() => {
    setBoardItems(data?.assignments ?? []);
  }, [data]);

  // If the currently-loaded view disappears (deleted in /views or another tab),
  // clear loadedViewId so Update doesn't PATCH a 404. Skip while still loading
  // or on transient fetch error so a brief network blip doesn't drop state.
  useEffect(() => {
    if (loadedViewId && !loadedViewLoading && !loadedViewError && !loadedView) {
      setLoadedViewId(null);
    }
  }, [loadedView, loadedViewError, loadedViewId, loadedViewLoading]);

  // Clear loadedViewId on workspace change. The component is reused across
  // /assignments and /w/:workspace/assignments via react-router; a view loaded
  // in one workspace must not appear as "loaded" in another (Update would PATCH
  // the source view with the wrong surface's filter state).
  useEffect(() => {
    setLoadedViewId(null);
    lastAppliedLoadViewRef.current = null;
    // Ephemeral saved-view-only filters: don't leak across scopes (the component
    // is reused across /assignments and /w/:workspace/assignments).
    setDateRange(null);
    setSearch('');
  }, [workspace]);

  // Track the URL params we last reacted to, so we can tell a genuine URL-driven
  // change (back/forward nav, an external link, the bootstrap seed) apart from a
  // re-render caused by a chip toggle (where the param text is unchanged). Only
  // the former should rebuild the canonical query (Requirement 6).
  const lastUrlFilterParamsRef = useRef<{ status: string | null; stale: string | null }>({
    status: statusParam,
    stale: staleParam,
  });
  useEffect(() => {
    const nextStatus = parseStatusParam(statusParam);
    const nextActivity = normalizeActivityFilter(staleParam);
    // Set-equality guard: statusFilter is now string[]; a fresh array that is
    // semantically equal must NOT trigger setState (would loop with the
    // state->URL mirror below).
    if (!sameFilterValues(nextStatus, statusFilter)) {
      setStatusFilter(nextStatus);
    }
    if (nextActivity !== activityFilter) {
      setActivityFilter(nextActivity);
    }

    // Requirement 6: a URL-param-driven chip change must also rebuild the
    // canonical query. Fire ONLY when the param TEXT actually changed since we
    // last reacted (true URL navigation / bootstrap seed) — never on a re-render
    // caused by a chip toggle (the toggle's own handler already rebuilt the
    // query, and rebuilding here off stale URL text would fight that). This is
    // still the chip → query direction driven from the URL-owning handler, NOT a
    // standalone effect watching chips. `query` is intentionally not a dep.
    const prev = lastUrlFilterParamsRef.current;
    const urlParamChanged = prev.status !== statusParam || prev.stale !== staleParam;
    lastUrlFilterParamsRef.current = { status: statusParam, stale: staleParam };
    if (urlParamChanged) {
      syncQueryFromChips({ status: nextStatus, activity: nextActivity });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityFilter, staleParam, statusFilter, statusParam]);

  useEffect(() => {
    // Only mirror state -> URL once bootstrap for the current scope has
    // completed. During scope switches the bootstrap re-runs and this gate
    // re-closes until the new scope's seed is applied.
    if (bootstrappedScopeRef.current !== scope) return;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);

      if (statusFilter.length === 0) {
        next.delete('status');
      } else {
        next.set('status', statusFilter.join(','));
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
    setPriorityFilter(toFilterValues(prefs.filters.priority));
    setTypeFilter(toFilterValues(prefs.filters.type));
    setAssigneeFilter(toFilterValues(prefs.filters.assignee));
    setProjectFilter(toFilterValues(prefs.filters.project));
    setTagsFilter(toFilterValues(prefs.filters.tags));
    setSortField(prefs.sortField);
    setSortDirection(prefs.sortDirection);
    setGrouping(prefs.grouping);
  }, [
    prefs.filters.priority,
    prefs.filters.type,
    prefs.filters.assignee,
    prefs.filters.project,
    prefs.filters.tags,
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
      const wantStatus = toFilterValues(p.filters.status);
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
      if (currentSP.get('status') === null && wantStatus.length > 0) {
        // Don't pre-validate against VALID_STATUS_SET here — statusConfig is
        // also async and may not be loaded yet. The URL->state effect
        // (parseStatusParam) gracefully drops unknown values, and the state->URL
        // effect tidies the URL on the next render.
        nextParams.set('status', wantStatus.join(','));
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
      // Rebuild the canonical query from the authoritative per-scope chip state we
      // just settled (server prefs + URL). This is the ONE place chips→query is
      // driven on a (re)bootstrap, keeping `query` coherent with the hydrated chips
      // without a standalone effect watching chips. The effective status/activity
      // honor the URL when present, else the persisted prefs; the other chips come
      // from the merged prefs `p` (which the prefs-hydrate effect also applies).
      const effStatus = parseStatusParam(nextParams.get('status'));
      const effActivity =
        nextParams.get('stale') === null ? wantActivity : normalizeActivityFilter(nextParams.get('stale'));
      setQuery(
        viewFiltersToQuery({
          status: effStatus,
          priority: toFilterValues(p.filters.priority),
          type: toFilterValues(p.filters.type),
          assignee: toFilterValues(p.filters.assignee),
          project: toFilterValues(p.filters.project),
          tags: toFilterValues(p.filters.tags),
          activity: effActivity === 'fresh' || effActivity === 'stale' ? effActivity : 'all',
        }),
      );
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

  // ── Chip ↔ query bridge ─────────────────────────────────────────────────────
  // `query` is canonical. Each chip onChange below updates its own chip state,
  // persists the pref, THEN recomputes the canonical query from the full set of
  // chip states (with the one being changed overridden, so we don't read stale
  // state). This is the chip → query (write) direction. The query → chips (read)
  // direction lives in `handleQueryChange`. Neither side uses an effect that
  // watches the other, so there is no feedback loop.
  //
  // Refs mirror the current chip state so the assemble helper reads fresh values
  // synchronously inside an event handler (a setX call does not update the
  // closed-over state variable until the next render).
  // Single source of truth: the per-render assignment below is canonical.
  // useRef is initialised with null! (typed placeholder) so there is no
  // duplicate field-list to drift out of sync with the reassignment.
  const chipStateRef = useRef<{
    status: string[];
    priority: string[];
    type: string[];
    assignee: string[];
    project: string[];
    tags: string[];
    activity: ActivityFilter;
    dateRange: DateRangeUiState | null;
    search: string;
  }>(null!);
  chipStateRef.current = {
    status: statusFilter,
    priority: priorityFilter,
    type: typeFilter,
    assignee: assigneeFilter,
    project: projectFilter,
    tags: tagsFilter,
    activity: activityFilter,
    dateRange,
    search,
  };

  // Assemble a ViewFilters from the live chip state, applying `overrides` for the
  // chip just changed (its setX hasn't committed yet, so read the new value here).
  const assembleChipFilters = useCallback(
    (overrides: Partial<ViewFilters> = {}): ViewFilters => {
      const c = chipStateRef.current;
      return {
        status: c.status,
        priority: c.priority,
        type: c.type,
        assignee: c.assignee,
        project: c.project,
        tags: c.tags,
        activity: c.activity,
        dateRange: minimizeDateRange(c.dateRange),
        search: c.search,
        ...overrides,
      };
    },
    [],
  );

  // Recompute and set the canonical query from chip state + this change's override.
  const syncQueryFromChips = useCallback(
    (overrides: Partial<ViewFilters> = {}) => {
      setQuery(viewFiltersToQuery(assembleChipFilters(overrides)));
    },
    [assembleChipFilters],
  );

  // Multi-value: persist the explicit array (incl. [] to clear — prefs deep-merge
  // treats an omitted key as "preserve", so clearing must be sent explicitly).
  const handleSetStatusFilter = useCallback(
    (v: string[]) => {
      setStatusFilter(v);
      persistField({ filters: { status: v } });
      syncQueryFromChips({ status: v });
    },
    [persistField, syncQueryFromChips],
  );
  const handleSetPriorityFilter = useCallback(
    (v: string[]) => {
      setPriorityFilter(v);
      persistField({ filters: { priority: v } });
      syncQueryFromChips({ priority: v });
    },
    [persistField, syncQueryFromChips],
  );
  const handleSetTypeFilter = useCallback(
    (v: string[]) => {
      setTypeFilter(v);
      persistField({ filters: { type: v } });
      syncQueryFromChips({ type: v });
    },
    [persistField, syncQueryFromChips],
  );
  const handleSetAssigneeFilter = useCallback(
    (v: string[]) => {
      setAssigneeFilter(v);
      persistField({ filters: { assignee: v } });
      syncQueryFromChips({ assignee: v });
    },
    [persistField, syncQueryFromChips],
  );
  const handleSetProjectFilter = useCallback(
    (v: string[]) => {
      setProjectFilter(v);
      persistField({ filters: { project: v } });
      syncQueryFromChips({ project: v });
    },
    [persistField, syncQueryFromChips],
  );
  const handleSetTagsFilter = useCallback(
    (v: string[]) => {
      setTagsFilter(v);
      persistField({ filters: { tags: v } });
      syncQueryFromChips({ tags: v });
    },
    [persistField, syncQueryFromChips],
  );
  const handleSetActivityFilter = useCallback(
    (v: ActivityFilter) => {
      setActivityFilter(v);
      persistField({ filters: { activity: v } });
      syncQueryFromChips({ activity: v });
    },
    [persistField, syncQueryFromChips],
  );
  // search + dateRange are saved-view-only chips set inline in the JSX. Wrap them
  // so they also drive the canonical query (chip → query write direction).
  const handleSetSearch = useCallback(
    (v: string) => {
      setSearch(v);
      syncQueryFromChips({ search: v });
    },
    [syncQueryFromChips],
  );
  const handleSetDateRange = useCallback(
    (v: DateRangeUiState | null) => {
      setDateRange(v);
      syncQueryFromChips({ dateRange: minimizeDateRange(v) });
    },
    [syncQueryFromChips],
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
  // Reset the board's primary filters (search, status, tags, date range,
  // activity) back to their defaults — used by the "no matches" empty state.
  const handleClearAllFilters = useCallback(() => {
    handleSetSearch('');
    handleSetStatusFilter([]);
    handleSetTagsFilter([]);
    handleSetDateRange(null);
    handleSetActivityFilter('all');
  }, [
    handleSetSearch,
    handleSetStatusFilter,
    handleSetTagsFilter,
    handleSetDateRange,
    handleSetActivityFilter,
  ]);

  // Query → chips (read / typed edits). The user edited the raw query in the
  // QueryInput box: `query` is canonical, so always set it. Then, if the query is
  // chip-representable, mirror it onto the individual chip states using the RAW
  // STATE SETTERS (NOT the handleSetX onChange wrappers). A direct setState never
  // re-invokes the chip onChange handlers, so there is no chip → query → chip
  // feedback loop. When NOT representable, the chips drop into read-only fallback
  // (see `chipsRepresentable`) and we leave their state untouched.
  const handleQueryChange = useCallback(
    (q: string) => {
      setQuery(q);
      const vf = queryToViewFilters(q);
      if (!vf) return; // not chip-representable → read-only fallback, chips frozen
      setStatusFilter(toFilterValues(vf.status));
      setPriorityFilter(toFilterValues(vf.priority));
      setTypeFilter(toFilterValues(vf.type));
      setAssigneeFilter(toFilterValues(vf.assignee));
      setProjectFilter(toFilterValues(vf.project));
      setTagsFilter(toFilterValues(vf.tags));
      setSearch(vf.search ?? '');
      setActivityFilter(vf.activity && vf.activity !== 'all' ? vf.activity : 'all');
      setDateRange(expandDateRange(vf.dateRange));
    },
    [],
  );

  // Is the canonical query expressible by the chips? Drives the chip disabled
  // state + the "advanced query" indicator. Memoized on `query` only.
  const chipsRepresentable = useMemo(() => queryToViewFilters(query) !== null, [query]);

  const buildViewState = useCallback(
    () => {
      // `query` is the canonical filter and is ALWAYS persisted. When it is
      // chip-representable, ALSO persist the legacy chip keys so summarizeFilters /
      // inferLandingRoute / ProjectDetail (chips-only) keep working. When it is NOT
      // representable, persist ONLY the query and omit the untranslatable chip keys
      // (minimizeFilters drops empty arrays / 'all', so empties here === omitted).
      const representable = queryToViewFilters(query) !== null;
      const chipFilters: ViewFilters = representable
        ? {
            status: statusFilter,
            priority: priorityFilter,
            type: typeFilter,
            assignee: assigneeFilter,
            project: projectFilter,
            tags: tagsFilter,
            activity: activityFilter,
            dateRange: minimizeDateRange(dateRange),
            search,
          }
        : {};
      return {
        viewMode: view,
        filters: {
          ...chipFilters,
          query,
        },
        sortField,
        sortDirection,
        listSectionVisibility: { collapsed: [...collapsedGroups] },
        kanbanColumnVisibility,
        tableColumnVisibility,
      };
    },
    [
      view,
      query,
      statusFilter,
      priorityFilter,
      typeFilter,
      assigneeFilter,
      projectFilter,
      tagsFilter,
      activityFilter,
      dateRange,
      search,
      sortField,
      sortDirection,
      collapsedGroups,
      kanbanColumnVisibility,
      tableColumnVisibility,
    ],
  );

  const applyViewToState = useCallback(
    (v: SavedView) => {
      // IMPORTANT: applyConfig sets `query` (the canonical filter) AND the chip
      // states. The chips must be set via the RAW state setters here — NOT the
      // handleSetX onChange wrappers — because those recompute `query` from chip
      // state and would clobber the view's stored (possibly non-chip-representable)
      // query during the apply burst. We still persist the applied chip values to
      // prefs, mirroring the historical apply behavior, but we never let the chip
      // path overwrite the canonical query that applyConfig set from the view.
      applyConfig(v, {
        setViewMode: setView,
        setQuery,
        setStatusFilter: (val) => { setStatusFilter(val); persistField({ filters: { status: val } }); },
        setPriorityFilter: (val) => { setPriorityFilter(val); persistField({ filters: { priority: val } }); },
        setTypeFilter: (val) => { setTypeFilter(val); persistField({ filters: { type: val } }); },
        setAssigneeFilter: (val) => { setAssigneeFilter(val); persistField({ filters: { assignee: val } }); },
        setProjectFilter: (val) => { setProjectFilter(val); persistField({ filters: { project: val } }); },
        setTagsFilter: (val) => { setTagsFilter(val); persistField({ filters: { tags: val } }); },
        setActivityFilter: (val) => { setActivityFilter(val); persistField({ filters: { activity: val } }); },
        setDateRange,
        setSearch,
        setSortField: handleSetSortField,
        setSortDirection: handleSetSortDirection,
        setListSectionVisibility: (vis) => setCollapsedGroups(new Set(vis.collapsed)),
        setKanbanColumnVisibility,
        setTableColumnVisibility,
      });
      setLoadedViewId(v.id);
    },
    [
      setView,
      persistField,
      handleSetSortField,
      handleSetSortDirection,
    ],
  );

  const handleApplyView = useCallback(
    (v: SavedView) => {
      applyViewToState(v);
      // Mark as already applied so the loadView effect doesn't re-apply.
      lastAppliedLoadViewRef.current = v.id;
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('loadView', v.id);
          return next;
        },
        { replace: true },
      );
    },
    [applyViewToState, setSearchParams],
  );

  const handleSave = useCallback(
    async (name: string) => {
      try {
        const payload = captureCurrentView({
          name,
          context: { workspace: workspace ?? null, projectSlug: null },
          state: buildViewState(),
        });
        const file = await createSavedView(payload);
        const created = file.views[file.views.length - 1];
        setLoadedViewId(created?.id ?? null);
        if (created) {
          lastAppliedLoadViewRef.current = created.id;
          setSearchParams(
            (prev) => {
              const next = new URLSearchParams(prev);
              next.set('loadView', created.id);
              return next;
            },
            { replace: true },
          );
        }
        setSaveDialogOpen(false);
        setSaveAsNewMode(false);
        showToast(`Saved view "${name}"`, 'success');
      } catch (err) {
        showToast(
          err instanceof Error ? err.message : 'Failed to save view',
          'error',
        );
        throw err;
      }
    },
    [buildViewState, setSearchParams, showToast, workspace],
  );

  const handleUpdateView = useCallback(async () => {
    if (!loadedViewId || !loadedView) return;
    try {
      const payload = captureCurrentView({
        name: loadedView.name,
        context: { workspace: workspace ?? null, projectSlug: null },
        state: buildViewState(),
      });
      // Merge onto the existing config: visibility from the live capture, but
      // unknown top-level + filter keys preserved from the loaded view.
      const config = mergeUpdatedConfig(loadedView.config, payload.config, payload.config);
      await updateSavedView(loadedViewId, { config });
      showToast('View updated', 'success');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Failed to update view',
        'error',
      );
    }
  }, [buildViewState, loadedView, loadedViewId, showToast, workspace]);

  // ?loadView= handler. Tracks lastAppliedLoadViewRef to avoid re-applying on
  // every render while waiting for the file to load.
  useEffect(() => {
    if (!loadViewParam) {
      lastAppliedLoadViewRef.current = null;
      return;
    }
    if (lastAppliedLoadViewRef.current === loadViewParam) return;
    // Clear loadedViewId eagerly so Update doesn't point at the prior view.
    if (loadedViewId && loadedViewId !== loadViewParam) {
      setLoadedViewId(null);
    }
    if (pendingViewLoading) return;
    if (pendingViewError) {
      // Don't mark as applied — a later refetch may succeed, and we want
      // this effect to re-run when `pendingView` / `pendingViewError` flips.
      // The param stays in the URL so the recovery is automatic on next fetch.
      showToast("Couldn't load saved view — try again", 'error');
      return;
    }
    if (pendingView) {
      lastAppliedLoadViewRef.current = loadViewParam;
      applyViewToState(pendingView);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('loadView');
          return next;
        },
        { replace: true },
      );
      return;
    }
    // !loading && !error && view === null → genuine orphan: server returned
    // 200 with no matching id in file.views. Strip the param and mark applied
    // so we don't re-toast on each render.
    lastAppliedLoadViewRef.current = loadViewParam;
    showToast('Saved view no longer exists', 'error');
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('loadView');
        return next;
      },
      { replace: true },
    );
  }, [
    loadViewParam,
    pendingView,
    pendingViewLoading,
    pendingViewError,
    loadedViewId,
    applyViewToState,
    setSearchParams,
    showToast,
  ]);

  // Filter-bar option lists must be scoped to the current workspace (the board
  // applies workspace filtering at match time), or /w/<ws> dropdowns would offer
  // dead cross-workspace assignees/projects that get persisted into prefs/views.
  const workspaceItems = useMemo(
    () =>
      boardItems.filter((a) =>
        !workspace
          ? true
          : workspace === '_ungrouped'
            ? a.projectWorkspace === null
            : a.projectWorkspace === workspace,
      ),
    [boardItems, workspace],
  );
  const uniqueStatuses = useMemo(
    () => Array.from(new Set(workspaceItems.map((a) => a.status))).sort(),
    [workspaceItems],
  );
  const uniquePriorities = useMemo(
    () => Array.from(new Set(workspaceItems.map((a) => a.priority))).sort(),
    [workspaceItems],
  );
  const uniqueAssignees = useMemo(
    () => Array.from(new Set(workspaceItems.map((a) => a.assignee ?? '__unassigned__'))).sort(),
    [workspaceItems],
  );
  const uniqueProjects = useMemo(
    () =>
      Array.from(
        new Map(
          workspaceItems
            .filter((a): a is typeof a & { projectSlug: string; projectTitle: string } => a.projectSlug !== null)
            .map((a) => [a.projectSlug, a.projectTitle]),
        ),
      ).sort(([, a], [, b]) => a.localeCompare(b)),
    [workspaceItems],
  );
  const uniqueTags = useMemo(
    () => Array.from(new Set(workspaceItems.flatMap((a) => a.tags ?? []))).sort(),
    [workspaceItems],
  );

  // Client AQL field registry: built-in assignment vocabulary + any custom-fact
  // declarations from status config. One registry per declarations change so the
  // compile cache stays warm.
  const registry = useMemo(
    () => buildQueryRegistry(statusConfig.factDeclarations),
    [statusConfig.factDeclarations],
  );

  // Compile the canonical query against the registry. Empty OR invalid query →
  // null here, which the filter step treats as MATCH-ALL (a typo never blanks the
  // board; the parse error already shows inline in QueryInput).
  const compiled = useMemo(() => {
    if (query.trim() === '') return null;
    const result = compileQuery(query, registry);
    return result.query; // CompiledQuery on success, null on parse/compile error
  }, [query, registry]);

  // Apply the compiled predicate through the AQL evaluator. Workspace + archived
  // stay OUTSIDE the query (page options), exactly as before. compiled === null
  // (empty/invalid) → match-all via filterBoardItems' null-predicate path: only
  // the page-level pre-filters (archived-exclude + workspace / _ungrouped) run.
  const filteredItems = useMemo(
    () => filterBoardItems(boardItems, compiled, { workspace }),
    [boardItems, compiled, workspace],
  );

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
        groups.push({ id: UNKNOWN_TYPE_COLUMN_ID, label: 'Other', items: unknown });
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

  // Add an "Other" column to the type kanban when any filtered item has a null
  // / unrecognized type slug. Mirrors the list-view bucketing so the same
  // assignment doesn't move between buckets when the user switches views.
  const TYPE_KANBAN_COLUMNS_WITH_FALLBACK: KanbanColumn[] = useMemo(() => {
    const knownIds = new Set(typesConfig.definitions.map((d) => d.id));
    const hasUnknown = filteredItems.some((it) => !it.type || !knownIds.has(it.type));
    return hasUnknown
      ? [
          ...TYPE_KANBAN_COLUMNS,
          { id: UNKNOWN_TYPE_COLUMN_ID, title: 'Other', description: 'Assignments with no recognized type.' },
        ]
      : TYPE_KANBAN_COLUMNS;
  }, [TYPE_KANBAN_COLUMNS, typesConfig, filteredItems]);

  // Flat visible order depends on view. For list, follow the active grouping
  // (which may be any GROUPINGS value). For kanban, follow effectiveKanbanGrouping
  // (status or type) so j/k traversal matches what the user sees on the board —
  // listGroups can iterate by priority/assignee/project, which would disagree
  // with the kanban renderer when the persisted grouping is unsupported by kanban.
  const { visibleItems, visibleIndexByKey } = useMemo(() => {
    let items: AssignmentBoardItem[];
    if (view === 'table') {
      items = sortedItems;
    } else if (view === 'kanban') {
      const knownIds = new Set(typesConfig.definitions.map((d) => d.id));
      if (effectiveKanbanGrouping === 'type') {
        items = [
          ...typesConfig.definitions.flatMap((def) => filteredItems.filter((it) => it.type === def.id)),
          ...filteredItems.filter((it) => !it.type || !knownIds.has(it.type)),
        ];
      } else {
        items = COLUMNS.flatMap((status) => filteredItems.filter((it) => it.status === status));
      }
    } else {
      items = listGroups.flatMap((g) => g.items);
    }
    const byKey = new Map<string, number>();
    items.forEach((it, i) => byKey.set(getAssignmentKey(it), i));
    return { visibleItems: items, visibleIndexByKey: byKey };
  }, [view, sortedItems, listGroups, effectiveKanbanGrouping, typesConfig, filteredItems, COLUMNS]);

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
    // A direct status change (no transition action) goes through the override
    // endpoint, which REJECTS terminal statuses ("use the complete/fail
    // transition"). Guard that path so a direct-set to a terminal status never
    // POSTs and 400s — it must be reached via its transition instead.
    if (!action) {
      const targetDef = statusConfig.statuses.find((s) => s.id === toColumnId);
      if (isTerminalStatus(targetDef ?? { id: toColumnId })) {
        showToast(
          `Reach “${getStatusLabel(statusConfig, toColumnId)}” through its complete/fail transition.`,
          'error',
        );
        return false;
      }
    }

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
      // Project assignments use slug-based routes; standalone use by-id routes.
      // Both support transitions (with action) AND direct override (no action).
      const updated = item.projectSlug === null
        ? action
          ? await runAssignmentTransitionById(item.id, action, reason)
          : await overrideAssignmentStatusById(item.id, toColumnId)
        : action
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
      showToast(`Moved to ${getStatusLabel(statusConfig, updated.status)}`, 'success');
      return true;
    } catch (mutationError) {
      setBoardItems(previous);
      showToast((mutationError as Error).message, 'error');
      return false;
    } finally {
      setTransitioningId(null);
    }
  }

  async function handleMove({
    item,
    toColumnId,
    action: providedAction,
  }: {
    item: AssignmentBoardItem;
    toColumnId: string;
    /**
     * The chosen transition action when the call originated from the inline
     * status-pill picker. When omitted (drag flow), we re-derive by target
     * status. Passing it through preserves `command` / `requiresReason` when
     * multiple commands share a target status.
     */
    action?: AssignmentTransitionAction;
  }) {
    if (item.status === toColumnId) {
      return;
    }

    const action = providedAction ?? getAssignmentAction(item, toColumnId);
    if (action?.disabled) {
      showToast(action.disabledReason || `Cannot move this assignment to ${toColumnId}.`, 'error');
      return;
    }

    if (action && transitionNeedsReason(action)) {
      setPendingMove({ item, toColumnId, action });
      return;
    }

    await applyMove({ item, toColumnId, action });
  }

  // Config-driven "Override → status" entries for a single card. Terminal targets
  // can't go through the override endpoint, so they're disabled unless the item
  // has an available transition to them (clicking then routes via that transition
  // inside handleMove). The current status is always disabled.
  function overrideTargetsFor(item: AssignmentBoardItem): StatusOverrideTarget[] {
    return deriveStatusOptions(statusConfig).map((option) => {
      if (option.id === item.status) {
        return { id: option.id, label: option.label, disabled: true, disabledReason: 'Already in this status' };
      }
      if (option.terminal) {
        const transition = item.availableTransitions.find(
          (a) => a.targetStatus === option.id && !a.disabled,
        );
        if (!transition) {
          return {
            id: option.id,
            label: option.label,
            disabled: true,
            disabledReason: `Reach ${option.label} via its transition when available`,
          };
        }
      }
      return { id: option.id, label: option.label };
    });
  }

  // A picker "Override → X" click is just a direct move to X with no chosen
  // transition; handleMove re-derives a transition when one exists (e.g. terminal
  // targets) and otherwise routes through the override path in applyMove.
  function handleOverride(item: AssignmentBoardItem, statusId: string) {
    void handleMove({ item, toColumnId: statusId });
  }

  async function handleRenameTitle(item: AssignmentBoardItem, newTitle: string): Promise<void> {
    if (newTitle === item.title) return;

    const key = getAssignmentKey(item);
    const previous = boardItems;
    setBoardItems((current) =>
      current.map((candidate) =>
        getAssignmentKey(candidate) === key ? { ...candidate, title: newTitle } : candidate,
      ),
    );
    setTransitioningId(key);

    try {
      const updated = item.projectSlug === null
        ? await updateAssignmentTitleById({ id: item.id, title: newTitle })
        : await updateAssignmentTitle({ projectSlug: item.projectSlug, assignmentSlug: item.slug, title: newTitle });

      setBoardItems((current) =>
        current.map((candidate) =>
          getAssignmentKey(candidate) === key
            ? { ...candidate, title: updated.title, updated: updated.updated }
            : candidate,
        ),
      );
      refetch();
    } catch (mutationError) {
      setBoardItems(previous);
      showToast((mutationError as Error).message, 'error');
      throw mutationError;
    } finally {
      setTransitioningId(null);
    }
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
        {/* Canonical AQL query box. Owns the filter applied to the board; the chips
            below are a visual editor over its chip-representable subset. */}
        <QueryInput
          className="w-full md:min-w-[320px] md:flex-1"
          value={query}
          onChange={handleQueryChange}
          registry={registry}
          declarations={statusConfig.factDeclarations}
          valueSources={{
            statuses: statusConfig.order,
            priorities: uniquePriorities,
            types: typesConfig.definitions.map((t) => t.id),
            assignees: uniqueAssignees.filter((a) => a !== '__unassigned__'),
            projects: uniqueProjects.map(([slug]) => slug),
            tags: uniqueTags,
          }}
        />
        {!chipsRepresentable ? (
          <span
            className="inline-flex items-center rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-700 dark:text-amber-300"
            title="This query uses features the chips can't represent (OR / NOT / grouping / advanced fields). Edit it in the query box; the chips are read-only until it becomes chip-representable again."
          >
            advanced query — edit in the box
          </span>
        ) : null}
        <SearchInput
          ref={searchRef}
          value={search}
          onChange={chipsRepresentable ? handleSetSearch : () => {}}
          placeholder="Search assignments or projects"
        />
        <MultiSelect
          ariaLabel="Status filter"
          className="max-w-[180px]"
          allLabel="All statuses"
          disabled={!chipsRepresentable}
          options={uniqueStatuses.map((s) => ({ value: s, label: COLUMN_LABELS[s] ?? s }))}
          value={statusFilter}
          onChange={handleSetStatusFilter}
        />
        <MultiSelect
          ariaLabel="Priority filter"
          className="max-w-[180px]"
          allLabel="All priorities"
          disabled={!chipsRepresentable}
          options={uniquePriorities.map((p) => ({ value: p, label: p[0].toUpperCase() + p.slice(1) }))}
          value={priorityFilter}
          onChange={handleSetPriorityFilter}
        />
        <MultiSelect
          ariaLabel="Type filter"
          className="max-w-[180px]"
          allLabel="All types"
          disabled={!chipsRepresentable}
          options={typesConfig.definitions.map((t) => ({ value: t.id, label: getTypeLabel(typesConfig, t.id) }))}
          value={typeFilter}
          onChange={handleSetTypeFilter}
        />
        <MultiSelect
          ariaLabel="Assignee filter"
          className="max-w-[180px]"
          allLabel="All assignees"
          disabled={!chipsRepresentable}
          options={[
            { value: '__unassigned__', label: 'Unassigned' },
            ...uniqueAssignees
              .filter((a) => a !== '__unassigned__')
              .map((a) => ({ value: a, label: a })),
          ]}
          value={assigneeFilter}
          onChange={handleSetAssigneeFilter}
        />
        <MultiSelect
          ariaLabel="Project filter"
          className="max-w-[180px]"
          allLabel="All projects"
          disabled={!chipsRepresentable}
          options={[
            { value: '__standalone__', label: 'Standalone' },
            ...uniqueProjects.map(([slug, title]) => ({ value: slug, label: title })),
          ]}
          value={projectFilter}
          onChange={handleSetProjectFilter}
        />
        <MultiSelect
          ariaLabel="Tags filter"
          className="max-w-[180px]"
          allLabel="Any tags"
          disabled={!chipsRepresentable}
          options={uniqueTags.map((t) => ({ value: t, label: t }))}
          value={tagsFilter}
          onChange={handleSetTagsFilter}
        />
        <DateRangeControl
          className="max-w-[200px]"
          value={dateRange}
          onChange={chipsRepresentable ? handleSetDateRange : () => {}}
        />
        <select value={activityFilter} disabled={!chipsRepresentable} onChange={(e) => handleSetActivityFilter(e.target.value as ActivityFilter)} className="editor-input max-w-[180px]" aria-label="Filter by activity" title="Filter by activity">
          <option value="all">All activity</option>
          <option value="stale">Stale only</option>
          <option value="fresh">Fresh only</option>
        </select>
        <select value={view === 'kanban' ? effectiveKanbanGrouping : grouping} onChange={(e) => handleSetGrouping(e.target.value as Grouping)} className="editor-input max-w-[180px]" title="Group by">
          {GROUPINGS.map((g) => {
            const isKanbanUnsupported = view === 'kanban' && g !== 'status' && g !== 'type';
            const label = g === 'none' ? 'No grouping' : `Group: ${g.charAt(0).toUpperCase() + g.slice(1)}`;
            return (
              <option key={g} value={g} disabled={isKanbanUnsupported}>
                {isKanbanUnsupported ? `${label} (list only)` : label}
              </option>
            );
          })}
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
        {view === 'table' ? (
          <TableColumnPicker
            visibility={tableColumnVisibility}
            onChange={setTableColumnVisibility}
          />
        ) : null}
        <SavedViewPicker
          scope={viewScope}
          loadedViewId={loadedViewId}
          onApply={handleApplyView}
          onOpenSaveDialog={() => {
            setSaveAsNewMode(false);
            setSaveDialogOpen(true);
          }}
        />
        <button
          type="button"
          onClick={() => {
            if (loadedView) {
              void handleUpdateView();
            } else {
              setSaveAsNewMode(false);
              setSaveDialogOpen(true);
            }
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/60 px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-background"
          title={loadedView ? `Update ${loadedView.name}` : 'Save current view'}
        >
          {loadedView ? `Update '${loadedView.name}'` : 'Save view'}
        </button>
        {loadedView ? (
          <button
            type="button"
            onClick={() => {
              setSaveAsNewMode(true);
              setSaveDialogOpen(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/60 px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-background"
            title="Save as new view"
          >
            Save as new…
          </button>
        ) : null}
      </FilterBar>

      {data.assignments.length === 0 ? (
        <EmptyState
          title="No assignments yet"
          description="Assignments appear here once projects contain concrete work items."
          actions={
            <Link className="shell-action shell-action--cta" to={`${wsPrefix}/projects`}>
              <FolderKanban className="h-4 w-4" />
              <span>Browse Projects</span>
            </Link>
          }
        />
      ) : filteredItems.length === 0 ? (
        <EmptyState
          title="No assignments match these filters"
          description="Adjust the search term or filters to show assignments across all projects again."
          actions={
            <button
              type="button"
              onClick={handleClearAllFilters}
              className="shell-action shell-action--cta"
            >
              <FilterX className="h-4 w-4" />
              <span>Clear all filters</span>
            </button>
          }
        />
      ) : view === 'table' ? (
        (() => {
          const hiddenCols = new Set(tableColumnVisibility.hidden);
          // `title` is non-hideable in the picker (TableColumnPicker.tsx:NON_HIDEABLE).
          // Defensively force-show it here so a persisted view with `hidden: ['title']`
          // (from an older version, a malformed payload, etc.) does not leave the table
          // without assignment links and no way to restore them via the picker.
          const showCol = (id: TableColumnId) => id === 'title' || !hiddenCols.has(id);
          return (
        <SectionCard title={`${sortedItems.length} assignment${sortedItems.length === 1 ? '' : 's'}`}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-border/60 text-muted-foreground">
                  {showCol('title') ? <SortHeader field="title">Assignment</SortHeader> : null}
                  {showCol('status') ? <SortHeader field="status">Status</SortHeader> : null}
                  <th className="py-2 pr-4 text-xs font-medium uppercase tracking-wider">Type</th>
                  {showCol('priority') ? <SortHeader field="priority">Priority</SortHeader> : null}
                  {showCol('assignee') ? <SortHeader field="assignee">Assignee</SortHeader> : null}
                  {showCol('dependencies') ? <SortHeader field="dependencies">Dependencies</SortHeader> : null}
                  {showCol('created') ? <SortHeader field="created">Created</SortHeader> : null}
                  {showCol('updated') ? <SortHeader field="updated">Updated</SortHeader> : null}
                </tr>
              </thead>
              <tbody>
                {sortedItems.map((assignment, i) => (
                  <ClickableTableRow
                    key={getAssignmentKey(assignment)}
                    detailHref={assignmentDetailHref(assignment)}
                    className="cursor-pointer border-b border-border/50 transition hover:bg-muted/40 last:border-0"
                    {...hotkeyRowProps(i)}
                  >
                    {showCol('title') ? (
                    <td className="py-4 pr-4">
                      <InlineTitleEditor
                        title={assignment.title}
                        detailHref={assignmentDetailHref(assignment)}
                        onSave={(next) => handleRenameTitle(assignment, next)}
                        disabled={transitioningId === getAssignmentKey(assignment)}
                      />
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
                    ) : null}
                    {showCol('status') ? (
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
                          resolveStatusAppearance(statusConfig.statuses, assignment.status).className,
                          transitioningId === getAssignmentKey(assignment) && 'animate-pulse opacity-60',
                        )}
                        style={resolveStatusAppearance(statusConfig.statuses, assignment.status).style}
                      >
                        {COLUMNS.map((targetStatus) => {
                          const isCurrent = assignment.status === targetStatus;
                          const action = isCurrent
                            ? undefined
                            : getAssignmentAction(assignment, targetStatus);
                          // Terminal targets can't be reached via override; disable
                          // them unless a transition exists (mirrors the picker).
                          const targetDef = statusConfig.statuses.find((s) => s.id === targetStatus);
                          const terminalNoTransition =
                            !isCurrent && isTerminalStatus(targetDef ?? { id: targetStatus }) && !action;
                          const disabled = (action?.disabled ?? false) || terminalNoTransition;
                          const disabledReason = terminalNoTransition
                            ? `Reach ${COLUMN_LABELS[targetStatus] ?? targetStatus} via its transition when available`
                            : action?.disabledReason ?? undefined;
                          return (
                            <option
                              key={targetStatus}
                              value={targetStatus}
                              disabled={disabled}
                              title={disabled ? disabledReason : undefined}
                            >
                              {COLUMN_LABELS[targetStatus]}
                            </option>
                          );
                        })}
                      </select>
                    </td>
                    ) : null}
                    <td className="py-4 pr-4">
                      <TypeChip type={assignment.type} compact />
                    </td>
                    {showCol('priority') ? <td className="py-4 pr-4 capitalize text-muted-foreground">{assignment.priority}</td> : null}
                    {showCol('assignee') ? <td className="py-4 pr-4 text-muted-foreground">{assignment.assignee ?? 'Unassigned'}</td> : null}
                    {showCol('dependencies') ? <td className="py-4 pr-4 text-muted-foreground">{assignment.dependsOn.length}</td> : null}
                    {showCol('created') ? <td className="py-4 pr-4 text-muted-foreground">{formatDate(assignment.created)}</td> : null}
                    {showCol('updated') ? <td className="py-4 text-muted-foreground">{formatDate(assignment.updated)}</td> : null}
                  </ClickableTableRow>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
          );
        })()
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
                      const dragEnabled = isStatusGroup;
                      return (
                        <div
                          key={itemKey}
                          draggable={dragEnabled}
                          onDragStart={dragEnabled ? (event) => handleDragStart(event, itemKey) : undefined}
                          onDragEnd={dragEnabled ? handleDragEnd : undefined}
                          {...(flatIdx >= 0 ? hotkeyRowProps(flatIdx) : {})}
                          className={cn(
                            'transition',
                            dragEnabled && 'cursor-grab active:cursor-grabbing',
                            isDragging && 'scale-[0.98] opacity-50',
                          )}
                        >
                          <AssignmentBoardCard
                            assignment={item}
                            dragging={isDragging}
                            transitioning={transitioningId === itemKey}
                            onPillSelect={(action) =>
                              void handleMove({ item, toColumnId: action.targetStatus, action })
                            }
                            overrideTargets={overrideTargetsFor(item)}
                            onOverride={(statusId) => handleOverride(item, statusId)}
                            onRenameTitle={(next) => handleRenameTitle(item, next)}
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
          columns={effectiveKanbanGrouping === 'type' ? TYPE_KANBAN_COLUMNS_WITH_FALLBACK : KANBAN_COLUMNS}
          items={filteredItems}
          getItemId={getAssignmentKey}
          getColumnId={(item) =>
            effectiveKanbanGrouping === 'type'
              ? (item.type && typesConfig.definitions.some((d) => d.id === item.type)
                  ? item.type
                  : UNKNOWN_TYPE_COLUMN_ID)
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
          onMove={effectiveKanbanGrouping === 'type' ? undefined : ({ item, toColumnId }) => handleMove({ item, toColumnId })}
          dragDisabled={effectiveKanbanGrouping === 'type'}
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
          hiddenColumnIds={kanbanColumnVisibility.hidden}
          onHideColumn={(columnId) =>
            setKanbanColumnVisibility((current) => {
              const isHidden = current.hidden.includes(columnId);
              return {
                hidden: isHidden
                  ? current.hidden.filter((c) => c !== columnId)
                  : [...current.hidden, columnId],
              };
            })
          }
          renderCard={(item, { dragging }) => {
            const flatIdx = visibleIndexByKey.get(getAssignmentKey(item)) ?? -1;
            return (
              <div {...(flatIdx >= 0 ? hotkeyRowProps(flatIdx) : {})}>
                <AssignmentBoardCard
                  assignment={item}
                  dragging={dragging}
                  transitioning={transitioningId === getAssignmentKey(item)}
                  onPillSelect={(action) =>
                    void handleMove({ item, toColumnId: action.targetStatus, action })
                  }
                  overrideTargets={overrideTargetsFor(item)}
                  onOverride={(statusId) => handleOverride(item, statusId)}
                  onRenameTitle={(next) => handleRenameTitle(item, next)}
                />
              </div>
            );
          }}
        />
      )}

      <Toaster toast={toast} onDismiss={dismissToast} />

      <SaveViewDialog
        open={saveDialogOpen}
        onOpenChange={(open) => {
          setSaveDialogOpen(open);
          if (!open) setSaveAsNewMode(false);
        }}
        initialName={saveAsNewMode && loadedView ? `${loadedView.name} (copy)` : ''}
        title={saveAsNewMode ? 'Save as new view' : 'Save view'}
        onSubmit={handleSave}
      />

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
            showToast('Assignment deleted', 'success');
          } catch (err) {
            showToast(err instanceof Error ? err.message : 'Failed to delete assignment', 'error');
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

/**
 * A table row whose body navigates to the assignment detail page on click,
 * reusing the same suppression rules as the kanban/list card (don't navigate
 * when dismissing a menu, committing an inline edit, or clicking an interactive
 * control). The hook must live in a component, so the per-row `<tr>` is wrapped
 * here rather than inlined in the table `.map()`.
 */
function ClickableTableRow({
  detailHref,
  children,
  className,
  ...rest
}: { detailHref: string } & React.ComponentPropsWithoutRef<'tr'>) {
  const nav = useBodyClickNavigation<HTMLTableRowElement>(detailHref);
  return (
    // `...rest` first so the nav ref/handlers always win — a caller's own
    // onClick/onMouseDown must never silently clobber row navigation.
    <tr
      {...rest}
      ref={nav.containerRef}
      className={className}
      onMouseDown={nav.onMouseDown}
      onClick={nav.onClick}
    >
      {children}
    </tr>
  );
}

function AssignmentBoardCard({
  assignment,
  dragging,
  transitioning,
  onPillSelect,
  overrideTargets,
  onOverride,
  onRenameTitle,
}: {
  assignment: AssignmentBoardItem;
  dragging: boolean;
  transitioning: boolean;
  /** Present in the kanban & list render-sites; absent → read-only card. */
  onPillSelect?: (action: AssignmentTransitionAction) => void;
  /** Config-driven direct-set targets for the status picker (per-item). */
  overrideTargets?: StatusOverrideTarget[];
  /** Direct-set handler paired with {@link overrideTargets}. */
  onOverride?: (statusId: string) => void;
  /** Present in the kanban & list render-sites; absent → read-only card. */
  onRenameTitle?: (newTitle: string) => Promise<void>;
}) {
  // Canonical per-item deep link: handles standalone vs project-nested and the
  // assignment's OWN workspace prefix (not the current page's), matching the
  // keyboard onOpen path and dashboard widgets. Body-click, the title editor's
  // external-link icon, and the read-only title <Link> all navigate through this.
  const detailHref = assignmentDetailHref(assignment);
  // Body-click navigation + inline edit are enabled wherever the render-site
  // passes onPillSelect + onRenameTitle (kanban and list). Without them the card
  // is read-only (plain title <Link> + StatusBadge, no body navigation).
  const inlineEditEnabled = Boolean(onPillSelect && onRenameTitle);
  // Shared with the table row: navigate on body click, suppressing clicks that
  // dismiss a menu, commit an inline edit, or hit an interactive control.
  const bodyNav = useBodyClickNavigation<HTMLDivElement>(detailHref);

  return (
    <div
      ref={inlineEditEnabled ? bodyNav.containerRef : undefined}
      className={cn(
        'vp-card rounded-lg border border-border/60 bg-background/85 p-3 shadow-sm',
        inlineEditEnabled && 'cursor-pointer',
      )}
      onMouseDown={inlineEditEnabled ? bodyNav.onMouseDown : undefined}
      onClick={inlineEditEnabled ? bodyNav.onClick : undefined}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          {inlineEditEnabled ? (
            <InlineTitleEditor
              title={assignment.title}
              detailHref={detailHref}
              onSave={onRenameTitle!}
              disabled={transitioning}
            />
          ) : (
            <Link to={detailHref} className="text-base font-semibold text-foreground hover:text-primary">
              {assignment.title}
            </Link>
          )}
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
        {inlineEditEnabled ? (
          <StatusPillPicker
            currentStatus={assignment.status}
            availableTransitions={assignment.availableTransitions}
            onSelect={onPillSelect!}
            overrideTargets={overrideTargets}
            onOverride={onOverride}
            disabled={transitioning}
            className="max-w-[150px]"
          />
        ) : (
          <StatusBadge status={assignment.status} className="max-w-[150px]" />
        )}
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
        {assignment.dependsOn.length > 0 ? (
          <span className="rounded-full border border-border/60 px-2.5 py-1 text-xs text-muted-foreground">
            {assignment.dependsOn.length} {assignment.dependsOn.length === 1 ? 'dependency' : 'dependencies'}
          </span>
        ) : null}
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
