import { type DragEvent, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronUp, FilterX, FolderKanban, Pencil, Trash2 } from 'lucide-react';
import { CopyButton } from '../components/CopyButton';
import { WorkflowSwimlanes } from '../components/WorkflowSwimlanes';
import { buildWorkflowLanes } from '../lib/workflow-board';
import { cn } from '../lib/utils';
import {
  useTicketsBoard,
  type TicketBoardItem,
  type TicketTransitionAction,
} from '../hooks/useProjects';
import {
  runTicketTransition,
  overrideTicketStatus,
  updateTicketTitle,
} from '../lib/tickets';
import { isTerminalStatus, resolveStatusAppearance } from '../lib/statusMeta';
import { getTicketColumns } from '../lib/kanban';
import { sortTickets } from '../lib/sortTickets';
import { formatDate } from '../lib/format';
import { ticketDetailHref } from '../lib/ticketFilter';
import { SearchInput } from '../components/SearchInput';
import { FilterBar } from '../components/FilterBar';
import { ViewToggle } from '../components/ViewToggle';
import { TableColumnPicker } from '../components/TableColumnPicker';
import { SectionCard } from '../components/SectionCard';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { KanbanBoard, type KanbanColumn } from '../components/KanbanBoard';
import { TicketTransitionDialog } from '../components/TicketTransitionDialog';
import { ContextMenuPopover } from '../components/ContextMenuPopover';
import { ConfirmDialog } from '../components/ConfirmDialog';
import type { OverflowMenuItem } from '../components/OverflowMenu';
import { StatusBadge, getStatusDescription } from '../components/StatusBadge';
import { TypeChip } from '../components/TypeChip';
import { TicketStatusPill } from '../components/TicketStatusPill';
import { InlineTitleEditor } from '../components/InlineTitleEditor';
import { useBodyClickNavigation } from '../hooks/useBodyClickNavigation';
import { useToast, Toaster } from '../components/Toast';
import { transitionNeedsReason } from '../lib/tickets';
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
  type TableColumnId,
  type ViewFilters,
} from '@shared/view-prefs-schema';
import { fetchViewPrefs, saveGlobalViewPrefs, saveScopeViewPrefs, useViewPrefs } from '../hooks/useViewPrefs';
import { mergeForScope } from '@shared/view-prefs-schema';
import { minimizeDateRange, expandDateRange, type DateRangeUiState } from '../lib/dateRange';
import { MultiSelect } from '../components/ui/MultiSelect';
import { DateRangeControl } from '../components/ui/DateRangeControl';
import { QueryInput } from '../components/QueryInput';
import { filterBoardItems } from '../lib/queryFilter';
import { buildQueryRegistry } from '@shared/fact-registry';
import { compileQuery } from '@shared/query';
import { viewFiltersToQuery, queryToViewFilters } from '@shared/view-filters-query';
const VALID_VIEWS: readonly ViewMode[] = VIEW_MODES;

interface PendingTicketMove {
  item: TicketBoardItem;
  toColumnId: string;
  action: TicketTransitionAction;
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

export function TicketsPage() {
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);
  useHotkeyScope('list:tickets');
  const { data, loading, error, refetch } = useTicketsBoard();
  const statusConfig = useStatusConfig();
  const typesConfig = useTypesConfig();
  const [searchParams, setSearchParams] = useSearchParams();

  const scope: string | null = null;
  const prefs = useViewPrefs(scope);
  // Tracks which scope the URL has been bootstrapped for. `undefined` = never.
  // Reset implicitly when `scope` changes (we re-bootstrap for the new scope).
  const bootstrappedScopeRef = useRef<string | null | undefined>(undefined);

  const COLUMNS = useMemo(() => getTicketColumns(statusConfig.order), [statusConfig]);
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
  // Kanban supports status / type / workflow grouping (workflow renders as
  // per-workflow swimlanes, matching ProjectDetail); any other persisted value
  // (set from list view) is rendered as status. The dropdown reflects this
  // coerced value when view === 'kanban' so the UI never disagrees with what
  // the board actually shows. Persisted value survives the view switch.
  const effectiveKanbanGrouping: 'status' | 'type' | 'workflow' =
    grouping === 'type' ? 'type' : grouping === 'workflow' ? 'workflow' : 'status';
  // Tracks group IDs the user has explicitly collapsed, keyed by the active
  // grouping's group id. Persisted via saved views: buildViewState derives the
  // serializable `listSectionVisibility` from this set, and applyConfig seeds it
  // back. New / unknown group IDs default to expanded.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [boardItems, setBoardItems] = useState<TicketBoardItem[]>([]);
  const { toast, showToast, dismissToast } = useToast();
  const [transitioningId, setTransitioningId] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTargetStatus, setDropTargetStatus] = useState<string | null>(null);
  const [pendingMove, setPendingMove] = useState<PendingTicketMove | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    item: TicketBoardItem;
    anchor: { x: number; y: number };
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TicketBoardItem | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  useEffect(() => {
    setBoardItems(data?.tickets ?? []);
  }, [data]);

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
  // /w/:workspace/tickets navigations).
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
  // Single source of truth: the per-render ticket below is canonical.
  // useRef is initialised with null! (typed placeholder) so there is no
  // duplicate field-list to drift out of sync with the reticket.
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
  const uniqueTags = useMemo(
    () => Array.from(new Set(boardItems.flatMap((a) => a.tags ?? []))).sort(),
    [boardItems],
  );

  // Client AQL field registry: built-in ticket vocabulary + any custom-fact
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

  // Apply the compiled predicate through the AQL evaluator. Archived exclusion
  // stays OUTSIDE the query (page option). compiled === null (empty/invalid) →
  // match-all via filterBoardItems' null-predicate path.
  const filteredItems = useMemo(
    () => filterBoardItems(boardItems, compiled),
    [boardItems, compiled],
  );

  const sortedItems = useMemo(
    () => sortTickets(filteredItems, sortField, sortDirection),
    [filteredItems, sortField, sortDirection],
  );

  // Derive list-view groups from prefs.grouping. Status (default) preserves
  // legacy behavior. Type and other dimensions are bucketed dynamically.
  // Each group is { id, label, items } in display order.
  // AC7: group from `sortedItems` (not `filteredItems`) so the list view honors
  // the active sort field/direction, matching the table and kanban views.
  const listGroups = useMemo(() => {
    if (grouping === 'none') {
      return [{ id: '__all__', label: 'All tickets', items: sortedItems }];
    }
    if (grouping === 'type') {
      const groups: { id: string; label: string; items: TicketBoardItem[] }[] = typesConfig.definitions.map((def) => ({
        id: def.id,
        label: getTypeLabel(typesConfig, def.id),
        items: sortedItems.filter((it) => it.type === def.id),
      }));
      const knownIds = new Set(typesConfig.definitions.map((d) => d.id));
      const unknown = sortedItems.filter((it) => !it.type || !knownIds.has(it.type));
      if (unknown.length > 0) {
        groups.push({ id: UNKNOWN_TYPE_COLUMN_ID, label: 'Other', items: unknown });
      }
      return groups;
    }
    if (grouping === 'priority') {
      const order: TicketBoardItem['priority'][] = ['critical', 'high', 'medium', 'low'];
      return order.map((p) => ({
        id: p,
        label: p.charAt(0).toUpperCase() + p.slice(1),
        items: sortedItems.filter((it) => it.priority === p),
      }));
    }
    if (grouping === 'assignee') {
      const assignees = Array.from(new Set(sortedItems.map((it) => it.assignee ?? '__unassigned__'))).sort();
      return assignees.map((a) => ({
        id: a,
        label: a === '__unassigned__' ? 'Unassigned' : a,
        items: sortedItems.filter((it) => (it.assignee ?? '__unassigned__') === a),
      }));
    }
    if (grouping === 'project') {
      const seen = new Map<string, string>();
      for (const it of sortedItems) {
        const key = it.projectSlug ?? '';
        const label = it.projectTitle ?? it.projectSlug ?? 'Unknown project';
        if (!seen.has(key)) seen.set(key, label);
      }
      return Array.from(seen.entries())
        .sort(([, a], [, b]) => a.localeCompare(b))
        .map(([key, label]) => ({
          id: key,
          label,
          items: sortedItems.filter((it) => (it.projectSlug ?? '') === key),
        }));
    }
    if (grouping === 'workflow') {
      const seen = new Map<string, string>();
      for (const it of sortedItems) {
        if (!seen.has(it.resolvedWorkflow)) {
          seen.set(it.resolvedWorkflow, it.workflowLabel || it.resolvedWorkflow);
        }
      }
      return Array.from(seen.entries()).map(([key, label]) => ({
        id: key,
        label,
        items: sortedItems.filter((it) => it.resolvedWorkflow === key),
      }));
    }
    // Default: status grouping
    return COLUMNS.map((status) => ({
      id: status,
      label: COLUMN_LABELS[status] ?? status,
      items: sortedItems.filter((it) => it.status === status),
    }));
  }, [grouping, sortedItems, typesConfig, COLUMNS, COLUMN_LABELS]);

  // Add an "Other" column to the type kanban when any filtered item has a null
  // / unrecognized type slug. Mirrors the list-view bucketing so the same
  // ticket doesn't move between buckets when the user switches views.
  const TYPE_KANBAN_COLUMNS_WITH_FALLBACK: KanbanColumn[] = useMemo(() => {
    const knownIds = new Set(typesConfig.definitions.map((d) => d.id));
    const hasUnknown = filteredItems.some((it) => !it.type || !knownIds.has(it.type));
    return hasUnknown
      ? [
          ...TYPE_KANBAN_COLUMNS,
          { id: UNKNOWN_TYPE_COLUMN_ID, title: 'Other', description: 'Tickets with no recognized type.' },
        ]
      : TYPE_KANBAN_COLUMNS;
  }, [TYPE_KANBAN_COLUMNS, typesConfig, filteredItems]);

  // Flat visible order depends on view. For list, follow the active grouping
  // (which may be any GROUPINGS value). For kanban, follow effectiveKanbanGrouping
  // (status or type) so j/k traversal matches what the user sees on the board —
  // listGroups can iterate by priority/assignee/project, which would disagree
  // with the kanban renderer when the persisted grouping is unsupported by kanban.
  const { visibleItems, visibleIndexByKey } = useMemo(() => {
    let items: TicketBoardItem[];
    if (view === 'table') {
      items = sortedItems;
    } else if (view === 'kanban') {
      const knownIds = new Set(typesConfig.definitions.map((d) => d.id));
      if (effectiveKanbanGrouping === 'type') {
        items = [
          ...typesConfig.definitions.flatMap((def) => filteredItems.filter((it) => it.type === def.id)),
          ...filteredItems.filter((it) => !it.type || !knownIds.has(it.type)),
        ];
      } else if (effectiveKanbanGrouping === 'workflow') {
        // Mirror the swimlane render order (lane → column → within) so j/k
        // traversal matches the board even for custom-workflow statuses.
        items = buildWorkflowLanes(filteredItems).flatMap((lane) =>
          lane.columns.flatMap((status) => lane.items.filter((it) => it.status === status)),
        );
      } else {
        items = COLUMNS.flatMap((status) => filteredItems.filter((it) => it.status === status));
      }
    } else {
      items = listGroups.flatMap((g) => g.items);
    }
    const byKey = new Map<string, number>();
    items.forEach((it, i) => byKey.set(getTicketKey(it), i));
    return { visibleItems: items, visibleIndexByKey: byKey };
  }, [view, sortedItems, listGroups, effectiveKanbanGrouping, typesConfig, filteredItems, COLUMNS]);

  const { hotkeyRowProps } = useListSelection(visibleItems, {
    scope: 'list:tickets',
    onOpen: (ticket) => {
      navigate(ticketDetailHref(ticket));
    },
  });
  useHotkey({
    keys: '/',
    scope: 'list:tickets',
    description: 'Focus filter',
    handler: () => searchRef.current?.focus(),
  });
  useHotkey({
    keys: 'r',
    scope: 'list:tickets',
    description: 'Refresh',
    handler: () => refetch(),
  });

  if (loading) {
    return <LoadingState label="Loading tickets board…" />;
  }

  if (error || !data) {
    return <ErrorState error={error || 'Tickets board is unavailable.'} onRetry={refetch} />;
  }

  async function applyMove({
    item,
    toColumnId,
    action,
    reason,
  }: {
    item: TicketBoardItem;
    toColumnId: string;
    action?: TicketTransitionAction;
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

    setTransitioningId(getTicketKey(item));

    const previous = boardItems;
    setBoardItems((current) =>
      current.map((candidate) =>
        getTicketKey(candidate) === getTicketKey(item)
          ? {
              ...candidate,
              status: toColumnId,
              blockedReason: toColumnId === 'blocked' ? reason ?? candidate.blockedReason : null,
            }
          : candidate,
      ),
    );

    try {
      // Project tickets use slug-based routes; standalone use by-id routes.
      // Both support transitions (with action) AND direct override (no action).
      const updated = action
        ? await runTicketTransition(item.id, action, reason)
        : await overrideTicketStatus(item.id, toColumnId);

      setBoardItems((current) =>
        current.map((candidate) =>
          getTicketKey(candidate) === getTicketKey(item)
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
    item: TicketBoardItem;
    toColumnId: string;
    /**
     * The chosen transition action when the call originated from the inline
     * status-pill picker. When omitted (drag flow), we re-derive by target
     * status. Passing it through preserves `command` / `requiresReason` when
     * multiple commands share a target status.
     */
    action?: TicketTransitionAction;
  }) {
    if (item.status === toColumnId) {
      return;
    }

    const action = providedAction ?? getTicketAction(item, toColumnId);
    if (action?.disabled) {
      showToast(action.disabledReason || `Cannot move this ticket to ${toColumnId}.`, 'error');
      return;
    }

    if (action && transitionNeedsReason(action)) {
      setPendingMove({ item, toColumnId, action });
      return;
    }

    await applyMove({ item, toColumnId, action });
  }

  // A picker "Override → X" click is just a direct move to X with no chosen
  // transition; handleMove re-derives a transition when one exists (e.g. terminal
  // targets) and otherwise routes through the override path in applyMove.
  function handleOverride(item: TicketBoardItem, statusId: string) {
    void handleMove({ item, toColumnId: statusId });
  }

  async function handleRenameTitle(item: TicketBoardItem, newTitle: string): Promise<void> {
    if (newTitle === item.title) return;

    const key = getTicketKey(item);
    const previous = boardItems;
    setBoardItems((current) =>
      current.map((candidate) =>
        getTicketKey(candidate) === key ? { ...candidate, title: newTitle } : candidate,
      ),
    );
    setTransitioningId(key);

    try {
      const updated = await updateTicketTitle({ id: item.id, title: newTitle });

      setBoardItems((current) =>
        current.map((candidate) =>
          getTicketKey(candidate) === key
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
    ? boardItems.find((item) => getTicketKey(item) === draggedId) ?? null
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
    const action = getTicketAction(draggedItem, status);
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
          placeholder="Search tickets or projects"
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
          options={uniqueProjects.map(([slug, title]) => ({ value: slug, label: title }))}
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
            const isKanbanUnsupported =
              view === 'kanban' && g !== 'status' && g !== 'type' && g !== 'workflow';
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
      </FilterBar>

      {data.tickets.length === 0 ? (
        <EmptyState
          title="No tickets yet"
          description="Tickets appear here once projects contain concrete work items."
          actions={
            <Link className="shell-action shell-action--cta" to={`/projects`}>
              <FolderKanban className="h-4 w-4" />
              <span>Browse Projects</span>
            </Link>
          }
        />
      ) : filteredItems.length === 0 ? (
        <EmptyState
          title="No tickets match these filters"
          description="Adjust the search term or filters to show tickets across all projects again."
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
          // without ticket links and no way to restore them via the picker.
          const showCol = (id: TableColumnId) => id === 'title' || !hiddenCols.has(id);
          return (
        <SectionCard title={`${sortedItems.length} ticket${sortedItems.length === 1 ? '' : 's'}`}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-border/60 text-muted-foreground">
                  {showCol('title') ? <SortHeader field="title">Ticket</SortHeader> : null}
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
                {sortedItems.map((ticket, i) => (
                  <ClickableTableRow
                    key={getTicketKey(ticket)}
                    detailHref={ticketDetailHref(ticket)}
                    className="cursor-pointer border-b border-border/50 transition hover:bg-muted/40 last:border-0"
                    {...hotkeyRowProps(i)}
                  >
                    {showCol('title') ? (
                    <td className="py-4 pr-4">
                      <InlineTitleEditor
                        title={ticket.title}
                        detailHref={ticketDetailHref(ticket)}
                        onSave={(next) => handleRenameTitle(ticket, next)}
                        disabled={transitioningId === getTicketKey(ticket)}
                      />
                      <p className="mt-1 text-xs text-muted-foreground">
                        {ticket.projectTitle ?? ticket.projectSlug ?? ''}
                      </p>
                      <p className="mt-0.5 inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground/70" title={ticket.id}>
                        {ticket.id.slice(0, 8)}
                        <CopyButton value={ticket.id} />
                      </p>
                    </td>
                    ) : null}
                    {showCol('status') ? (
                    <td className="py-4 pr-4">
                      <select
                        value={ticket.status}
                        disabled={transitioningId === getTicketKey(ticket)}
                        onChange={(e) =>
                          handleMove({ item: ticket, toColumnId: e.target.value })
                        }
                        className={cn(
                          'appearance-none rounded-full border px-2.5 py-0.5 text-xs font-semibold tracking-wide outline-none',
                          'cursor-pointer bg-[length:12px] bg-[right_6px_center] bg-no-repeat pr-6',
                          "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='currentColor'%3E%3Cpath fill-rule='evenodd' d='M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z'/%3E%3C/svg%3E\")]",
                          resolveStatusAppearance(statusConfig.statuses, ticket.status).className,
                          transitioningId === getTicketKey(ticket) && 'animate-pulse opacity-60',
                        )}
                        style={resolveStatusAppearance(statusConfig.statuses, ticket.status).style}
                      >
                        {COLUMNS.map((targetStatus) => {
                          const isCurrent = ticket.status === targetStatus;
                          const action = isCurrent
                            ? undefined
                            : getTicketAction(ticket, targetStatus);
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
                      <TypeChip type={ticket.type} compact />
                    </td>
                    {showCol('priority') ? <td className="py-4 pr-4 capitalize text-muted-foreground">{ticket.priority}</td> : null}
                    {showCol('assignee') ? <td className="py-4 pr-4 text-muted-foreground">{ticket.assignee ?? 'Unassigned'}</td> : null}
                    {showCol('dependencies') ? <td className="py-4 pr-4 text-muted-foreground">{ticket.dependsOn.length}</td> : null}
                    {showCol('created') ? <td className="py-4 pr-4 text-muted-foreground">{formatDate(ticket.created)}</td> : null}
                    {showCol('updated') ? <td className="py-4 text-muted-foreground">{formatDate(ticket.updated)}</td> : null}
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
                ? draggedItem.status !== groupId && !getTicketAction(draggedItem, groupId)?.disabled
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
                      const itemKey = getTicketKey(item);
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
                          <TicketBoardCard
                            ticket={item}
                            dragging={isDragging}
                            transitioning={transitioningId === itemKey}
                            onPillSelect={(action) =>
                              void handleMove({ item, toColumnId: action.targetStatus, action })
                            }
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
      ) : effectiveKanbanGrouping === 'workflow' ? (
        <WorkflowSwimlanes
          items={filteredItems}
          getItemId={getTicketKey}
          renderCard={(item, { dragging }) => {
            const flatIdx = visibleIndexByKey.get(getTicketKey(item)) ?? -1;
            return (
              <div {...(flatIdx >= 0 ? hotkeyRowProps(flatIdx) : {})}>
                <TicketBoardCard
                  ticket={item}
                  dragging={dragging}
                  transitioning={transitioningId === getTicketKey(item)}
                  onPillSelect={(action) =>
                    void handleMove({ item, toColumnId: action.targetStatus, action })
                  }
                  onOverride={(statusId) => handleOverride(item, statusId)}
                  onRenameTitle={(next) => handleRenameTitle(item, next)}
                />
              </div>
            );
          }}
          emptyMessage={(column) => `No ${column.title.toLowerCase()} tickets.`}
        />
      ) : (
        <KanbanBoard
          columns={effectiveKanbanGrouping === 'type' ? TYPE_KANBAN_COLUMNS_WITH_FALLBACK : KANBAN_COLUMNS}
          items={filteredItems}
          getItemId={getTicketKey}
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

            const action = getTicketAction(item, toColumnId);
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
          onCardContextMenu={(item, event) => {
            event.preventDefault();
            setContextMenu({ item, anchor: { x: event.clientX, y: event.clientY } });
          }}
          emptyMessage={(column) => `No ${column.title.toLowerCase()} tickets.`}
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
            const flatIdx = visibleIndexByKey.get(getTicketKey(item)) ?? -1;
            return (
              <div {...(flatIdx >= 0 ? hotkeyRowProps(flatIdx) : {})}>
                <TicketBoardCard
                  ticket={item}
                  dragging={dragging}
                  transitioning={transitioningId === getTicketKey(item)}
                  onPillSelect={(action) =>
                    void handleMove({ item, toColumnId: action.targetStatus, action })
                  }
                  onOverride={(statusId) => handleOverride(item, statusId)}
                  onRenameTitle={(next) => handleRenameTitle(item, next)}
                />
              </div>
            );
          }}
        />
      )}

      <Toaster toast={toast} onDismiss={dismissToast} />

      <TicketTransitionDialog
        open={pendingMove !== null}
        action={pendingMove?.action ?? null}
        ticketTitle={pendingMove?.item.title ?? 'Ticket'}
        loading={transitioningId === (pendingMove ? getTicketKey(pendingMove.item) : null)}
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
        items={contextMenu ? buildTicketContextMenu(contextMenu.item, {
          onEdit: () => navigate(ticketDetailHref(contextMenu.item)),
          onDelete: () => setDeleteTarget(contextMenu.item),
        }) : []}
        onClose={() => setContextMenu(null)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete ticket?"
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
          if (!deleteTarget) {
            setDeleteTarget(null);
            return;
          }
          const key = getTicketKey(deleteTarget);
          setDeletingKey(key);
          try {
            const res = await fetch(
              `/api/tickets/${encodeURIComponent(deleteTarget.id)}`,
              { method: 'DELETE' },
            );
            if (!res.ok) {
              const body = await res.json().catch(() => ({}));
              throw new Error(body.error || 'Failed to delete ticket');
            }
            setDeleteTarget(null);
            refetch();
            showToast('Ticket deleted', 'success');
          } catch (err) {
            showToast(err instanceof Error ? err.message : 'Failed to delete ticket', 'error');
          } finally {
            setDeletingKey(null);
          }
        }}
      />

    </div>
  );
}

function buildTicketContextMenu(
  item: TicketBoardItem,
  handlers: { onEdit: () => void; onDelete: () => void },
): OverflowMenuItem[] {
  const items: OverflowMenuItem[] = [
    { key: 'edit', label: 'Edit', icon: Pencil, onSelect: handlers.onEdit },
  ];
  if (item.projectSlug !== null) {
    items.push({
      key: 'delete',
      label: 'Delete',
      icon: Trash2,
      destructive: true,
      onSelect: handlers.onDelete,
    });
  }
  return items;
}

/**
 * A table row whose body navigates to the ticket detail page on click,
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

function TicketBoardCard({
  ticket,
  dragging,
  transitioning,
  onPillSelect,
  onOverride,
  onRenameTitle,
}: {
  ticket: TicketBoardItem;
  dragging: boolean;
  transitioning: boolean;
  /** Present in the kanban & list render-sites; absent → read-only card. */
  onPillSelect?: (action: TicketTransitionAction) => void;
  /** Direct-set handler for the status pill's "Override → status" entries. */
  onOverride?: (statusId: string) => void;
  /** Present in the kanban & list render-sites; absent → read-only card. */
  onRenameTitle?: (newTitle: string) => Promise<void>;
}) {
  // Canonical per-item deep link: handles standalone vs project-nested and the
  // ticket's OWN workspace prefix (not the current page's), matching the
  // keyboard onOpen path and dashboard widgets. Body-click, the title editor's
  // external-link icon, and the read-only title <Link> all navigate through this.
  const detailHref = ticketDetailHref(ticket);
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
              title={ticket.title}
              detailHref={detailHref}
              onSave={onRenameTitle!}
              disabled={transitioning}
            />
          ) : (
            <Link to={detailHref} className="text-base font-semibold text-foreground hover:text-primary">
              {ticket.title}
            </Link>
          )}
          <p className="text-sm text-muted-foreground">
            {ticket.projectTitle ?? ticket.projectSlug ?? ''}
          </p>
          <p className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground/70" title={ticket.id ?? ''}>
            {ticket.id?.slice(0, 8)}
            {ticket.id && <CopyButton value={ticket.id} />}
          </p>
        </div>
        {inlineEditEnabled ? (
          <TicketStatusPill
            id={ticket.id}
            slug={ticket.slug}
            projectSlug={ticket.projectSlug}
            status={ticket.status}
            availableTransitions={ticket.availableTransitions}
            title={ticket.title}
            disabled={transitioning}
            className="max-w-[150px]"
            onSelectAction={onPillSelect}
            onSelectOverride={onOverride}
          />
        ) : (
          <StatusBadge status={ticket.status} className="max-w-[150px]" />
        )}
      </div>

      {ticket.blockedReason ? (
        <p className="mt-3 rounded-md border border-warning-foreground/30 bg-warning px-3 py-2 text-sm text-warning-foreground">
          {ticket.blockedReason}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <TypeChip type={ticket.type} />
        <span className="rounded-full border border-border/60 px-2.5 py-1 text-xs capitalize text-muted-foreground">
          {ticket.priority}
        </span>
        <span className="rounded-full border border-border/60 px-2.5 py-1 text-xs text-muted-foreground">
          {ticket.assignee ?? 'Unassigned'}
        </span>
        {ticket.dependsOn.length > 0 ? (
          <span className="rounded-full border border-border/60 px-2.5 py-1 text-xs text-muted-foreground">
            {ticket.dependsOn.length} {ticket.dependsOn.length === 1 ? 'dependency' : 'dependencies'}
          </span>
        ) : null}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 text-xs uppercase tracking-[0.08em] text-muted-foreground">
        <span>{transitioning ? 'Updating' : dragging ? 'Dragging' : 'Source-first'}</span>
        <span>{formatDate(ticket.updated)}</span>
      </div>
    </div>
  );
}

function getTicketAction(
  ticket: TicketBoardItem,
  targetStatus: string,
): TicketTransitionAction | undefined {
  return ticket.availableTransitions.find((action) => action.targetStatus === targetStatus);
}

function getTicketKey(ticket: Pick<TicketBoardItem, 'id' | 'slug'>): string {
  return ticket.id || ticket.slug || 'unknown';
}
