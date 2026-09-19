import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  GROUPINGS,
  sameFilterValues,
  toFilterValues,
  type Activity,
  type Grouping,
  type ProjectViewPrefs,
  type SortDirection,
  type SortField,
  type ViewFilters,
  type ViewMode,
} from '@shared/view-prefs-schema';
import { viewFiltersToQuery } from '@shared/view-filters-query';
import { expandDateRange, minimizeDateRange, type DateRangeUiState } from '../lib/dateRange';
import { chipsFromQuery, mergeBoardFilters } from '../lib/boardFilters';
import type { HistoryMode } from '../lib/boardHistory';
import {
  boardUrlNavigateOptions,
  type BoardUrlNavigationIntent,
} from '../lib/boardUrlNavigation';
import {
  boardPreferenceScope,
  boardUrlParamsEqual,
  parseBoardUrlParams,
  serializeBoardUrlParams,
  type BoardDialog,
  type BoardPanel,
  type ProjectVisibility,
} from '../lib/boardUrlParams';
import { fetchViewPrefs, saveGlobalViewPrefs, saveScopeViewPrefs, useViewPrefs } from './useViewPrefs';

export interface BoardFilterState {
  view: ViewMode;
  status: string[];
  template: string[];
  priority: string[];
  assignee: string[];
  tags: string[];
  project: string[];
  activity: Activity;
  query: string;
  sortField: SortField;
  sortDirection: SortDirection;
  history: HistoryMode;
  olderThanDays: number;
  projectVisibility: ProjectVisibility;
  panel: BoardPanel | null;
  dialog: BoardDialog | null;
  grouping: Grouping;
  dateRange: DateRangeUiState | null;
  search: string;
  chipsRepresentable: boolean;
  preferenceScope: string | null;
  density: 'comfortable' | 'compact';
}

export interface BoardFilterActions {
  setView: (view: ViewMode) => void;
  setStatusFilter: (values: string[]) => void;
  setPriorityFilter: (values: string[]) => void;
  setTemplateFilter: (values: string[]) => void;
  setAssigneeFilter: (values: string[]) => void;
  setTagsFilter: (values: string[]) => void;
  setProjectFilter: (values: string[]) => void;
  setActivityFilter: (activity: Activity) => void;
  setQuery: (query: string) => void;
  setSortField: (field: SortField) => void;
  setSortDirection: (dir: SortDirection) => void;
  setGrouping: (grouping: Grouping) => void;
  setDateRange: (range: DateRangeUiState | null) => void;
  setSearch: (search: string) => void;
  setHistory: (mode: HistoryMode) => void;
  setOlderThanDays: (days: number) => void;
  setProjectVisibility: (visibility: ProjectVisibility) => void;
  setPanel: (panel: BoardPanel | null) => void;
  setDialog: (dialog: BoardDialog | null) => void;
  clearPrimaryFilters: () => void;
}

function currentChipSnapshot(state: {
  status: string[];
  priority: string[];
  template: string[];
  assignee: string[];
  project: string[];
  tags: string[];
  activity: Activity;
  dateRange: DateRangeUiState | null;
  search: string;
}): ViewFilters {
  return {
    status: state.status,
    priority: state.priority,
    template: state.template,
    assignee: state.assignee,
    project: state.project,
    tags: state.tags,
    activity: state.activity,
    dateRange: minimizeDateRange(state.dateRange),
    search: state.search,
  };
}

export { GROUPINGS };

export function useBoardFilters(): { state: BoardFilterState; actions: BoardFilterActions } {
  const location = useLocation();
  const navigate = useNavigate();
  const searchParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const urlState = useMemo(() => parseBoardUrlParams(searchParams), [searchParams]);
  const preferenceScope = boardPreferenceScope(urlState.project);
  const prefs = useViewPrefs(preferenceScope);

  const bootstrappedScopeRef = useRef<string | null | undefined>(undefined);
  const userGenerationRef = useRef(0);

  const [statusFilter, setStatusFilter] = useState<string[]>(urlState.status);
  const [priorityFilter, setPriorityFilter] = useState<string[]>(() => toFilterValues(prefs.filters.priority));
  const [templateFilter, setTemplateFilter] = useState<string[]>(() => toFilterValues(prefs.filters.template));
  const [assigneeFilter, setAssigneeFilter] = useState<string[]>(() => toFilterValues(prefs.filters.assignee));
  const [tagsFilter, setTagsFilter] = useState<string[]>(() => toFilterValues(prefs.filters.tags));
  const [projectFilter, setProjectFilter] = useState<string[]>(urlState.project);
  const [activityFilter, setActivityFilter] = useState<Activity>(urlState.stale ?? prefs.filters.activity ?? 'all');
  const [query, setQueryState] = useState('');
  const [sortField, setSortField] = useState<SortField>(urlState.sort ?? prefs.sortField);
  const [sortDirection, setSortDirection] = useState<SortDirection>(urlState.dir ?? prefs.sortDirection);
  const [view, setViewState] = useState<ViewMode>(urlState.view ?? prefs.defaultView);
  const [grouping, setGroupingState] = useState<Grouping>(prefs.grouping);
  const [dateRange, setDateRange] = useState<DateRangeUiState | null>(null);
  const [search, setSearchState] = useState('');

  const chipSnapshot = () =>
    currentChipSnapshot({
      status: statusFilter,
      priority: priorityFilter,
      template: templateFilter,
      assignee: assigneeFilter,
      project: projectFilter,
      tags: tagsFilter,
      activity: activityFilter,
      dateRange,
      search,
    });

  const syncQueryFromChips = useCallback(
    (overrides: Partial<ViewFilters> = {}) => {
      setQueryState(viewFiltersToQuery({ ...chipSnapshot(), ...overrides }));
    },
    [
      activityFilter,
      assigneeFilter,
      dateRange,
      priorityFilter,
      projectFilter,
      search,
      statusFilter,
      tagsFilter,
      templateFilter,
    ],
  );

  const persistPatch = useCallback(
    (patch: ProjectViewPrefs) => {
      const save =
        preferenceScope === null
          ? saveGlobalViewPrefs(patch)
          : saveScopeViewPrefs(preferenceScope, patch);
      save.catch((err) => console.warn('Failed to persist board view prefs:', err));
    },
    [preferenceScope],
  );

  const updateUrl = useCallback(
    (
      patch: Parameters<typeof serializeBoardUrlParams>[1],
      intent: BoardUrlNavigationIntent = 'preference-sync',
    ) => {
      const next = serializeBoardUrlParams(searchParams, patch);
      if (boardUrlParamsEqual(searchParams, next)) return;
      navigate(
        { pathname: location.pathname, search: `?${next}`, hash: location.hash },
        boardUrlNavigateOptions(intent),
      );
    },
    [location.hash, location.pathname, navigate, searchParams],
  );

  useEffect(() => {
    if (!sameFilterValues(urlState.status, statusFilter)) setStatusFilter(urlState.status);
    if (!sameFilterValues(urlState.project, projectFilter)) setProjectFilter(urlState.project);
    if (urlState.stale && urlState.stale !== activityFilter) setActivityFilter(urlState.stale);
    if (urlState.view) setViewState(urlState.view);
    if (urlState.sort) setSortField(urlState.sort);
    if (urlState.dir) setSortDirection(urlState.dir);
    if (urlState.query !== null && urlState.query !== query) setQueryState(urlState.query);
  }, [activityFilter, projectFilter, query, statusFilter, urlState]);

  useEffect(() => {
    if (bootstrappedScopeRef.current === preferenceScope) return;
    let cancelled = false;
    const generation = ++userGenerationRef.current;
    fetchViewPrefs().then((latest) => {
      if (cancelled || generation !== userGenerationRef.current) return;
      const live = parseBoardUrlParams(new URLSearchParams(window.location.search));
      const merged = mergeBoardFilters({
        url: live,
        prefsFile: latest,
        urlHasQuery: new URLSearchParams(window.location.search).has('query'),
      });
      setPriorityFilter(merged.priority);
      setTemplateFilter(merged.template);
      setAssigneeFilter(merged.assignee);
      setTagsFilter(merged.tags);
      setSortField(merged.sortField);
      setSortDirection(merged.sortDirection);
      setViewState(merged.view);
      setGroupingState(prefs.grouping);
      if (!new URLSearchParams(window.location.search).has('query')) {
        setQueryState(merged.query);
      }
      queueMicrotask(() => {
        bootstrappedScopeRef.current = preferenceScope;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [preferenceScope, prefs.grouping]);

  useEffect(() => {
    if (bootstrappedScopeRef.current !== preferenceScope) return;
    updateUrl(
      {
        status: statusFilter,
        stale: activityFilter,
        project: projectFilter.length === 0 && urlState.projectCleared ? 'clear' : projectFilter,
        view,
        sort: sortField,
        dir: sortDirection,
        query,
        history: urlState.history,
        olderThanDays: urlState.olderThanDays,
        projectVisibility: urlState.projectVisibility,
        panel: urlState.panel,
        dialog: urlState.dialog,
      },
      'bootstrap',
    );
  }, [
    activityFilter,
    preferenceScope,
    projectFilter,
    query,
    sortDirection,
    sortField,
    statusFilter,
    updateUrl,
    urlState.dialog,
    urlState.history,
    urlState.olderThanDays,
    urlState.panel,
    urlState.projectCleared,
    urlState.projectVisibility,
    view,
  ]);

  const actions: BoardFilterActions = {
    setView: (v) => {
      userGenerationRef.current += 1;
      setViewState(v);
      persistPatch({ defaultView: v });
      updateUrl({ view: v });
    },
    setStatusFilter: (v) => {
      userGenerationRef.current += 1;
      setStatusFilter(v);
      persistPatch({ filters: { status: v } });
      syncQueryFromChips({ status: v });
      updateUrl({ status: v });
    },
    setPriorityFilter: (v) => {
      userGenerationRef.current += 1;
      setPriorityFilter(v);
      persistPatch({ filters: { priority: v } });
      syncQueryFromChips({ priority: v });
      updateUrl({ priority: v });
    },
    setTemplateFilter: (v) => {
      userGenerationRef.current += 1;
      setTemplateFilter(v);
      persistPatch({ filters: { template: v } });
      syncQueryFromChips({ template: v });
      updateUrl({ template: v });
    },
    setAssigneeFilter: (v) => {
      userGenerationRef.current += 1;
      setAssigneeFilter(v);
      persistPatch({ filters: { assignee: v } });
      syncQueryFromChips({ assignee: v });
      updateUrl({ assignee: v });
    },
    setTagsFilter: (v) => {
      userGenerationRef.current += 1;
      setTagsFilter(v);
      persistPatch({ filters: { tags: v } });
      syncQueryFromChips({ tags: v });
      updateUrl({ tags: v });
    },
    setProjectFilter: (v) => {
      userGenerationRef.current += 1;
      setProjectFilter(v);
      syncQueryFromChips({ project: v });
      updateUrl({ project: v });
    },
    setActivityFilter: (v) => {
      userGenerationRef.current += 1;
      setActivityFilter(v);
      persistPatch({ filters: { activity: v } });
      syncQueryFromChips({ activity: v });
      updateUrl({ stale: v });
    },
    setQuery: (q) => {
      userGenerationRef.current += 1;
      setQueryState(q);
      updateUrl({ query: q });
      const vf = chipsFromQuery(q);
      if (!vf) return;
      setStatusFilter(toFilterValues(vf.status));
      setPriorityFilter(toFilterValues(vf.priority));
      setTemplateFilter(toFilterValues(vf.template));
      setAssigneeFilter(toFilterValues(vf.assignee));
      setProjectFilter(toFilterValues(vf.project));
      setTagsFilter(toFilterValues(vf.tags));
      setSearchState(vf.search ?? '');
      setActivityFilter(vf.activity && vf.activity !== 'all' ? vf.activity : 'all');
      setDateRange(expandDateRange(vf.dateRange));
    },
    setSortField: (v) => {
      userGenerationRef.current += 1;
      setSortField(v);
      persistPatch({ sortField: v });
      updateUrl({ sort: v });
    },
    setSortDirection: (v) => {
      userGenerationRef.current += 1;
      setSortDirection(v);
      persistPatch({ sortDirection: v });
      updateUrl({ dir: v });
    },
    setGrouping: (v) => {
      userGenerationRef.current += 1;
      setGroupingState(v);
      persistPatch({ grouping: v });
    },
    setDateRange: (v) => {
      userGenerationRef.current += 1;
      setDateRange(v);
      syncQueryFromChips({ dateRange: minimizeDateRange(v) });
    },
    setSearch: (v) => {
      userGenerationRef.current += 1;
      setSearchState(v);
      syncQueryFromChips({ search: v });
    },
    setHistory: (mode) => updateUrl({ history: mode }),
    setOlderThanDays: (days) => updateUrl({ olderThanDays: days }),
    setProjectVisibility: (visibility) => updateUrl({ projectVisibility: visibility }),
    setPanel: (panel) =>
      updateUrl({ panel }, panel ? 'open-ephemeral' : 'close-ephemeral'),
    setDialog: (dialog) =>
      updateUrl({ dialog }, dialog ? 'open-ephemeral' : 'close-ephemeral'),
    clearPrimaryFilters: () => {
      userGenerationRef.current += 1;
      setSearchState('');
      setStatusFilter([]);
      setTagsFilter([]);
      setDateRange(null);
      setActivityFilter('all');
      persistPatch({ filters: { status: [], tags: [], activity: 'all' } });
      syncQueryFromChips({ status: [], tags: [], activity: 'all', search: '' });
      updateUrl({ status: [], tags: [], stale: 'all', query: '' });
    },
  };

  const chipsRepresentable = useMemo(() => chipsFromQuery(query) !== null, [query]);

  const state: BoardFilterState = {
    view,
    status: statusFilter,
    template: templateFilter,
    priority: priorityFilter,
    assignee: assigneeFilter,
    tags: tagsFilter,
    project: projectFilter,
    activity: activityFilter,
    query,
    sortField,
    sortDirection,
    history: urlState.history,
    olderThanDays: urlState.olderThanDays,
    projectVisibility: urlState.projectVisibility,
    panel: urlState.panel,
    dialog: urlState.dialog,
    grouping,
    dateRange,
    search,
    chipsRepresentable,
    preferenceScope,
    density: prefs.density,
  };

  return { state, actions };
}
