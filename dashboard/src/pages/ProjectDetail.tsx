import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { BookOpenText, ChevronDown, ChevronUp, GitBranch, Plus, SquarePen } from 'lucide-react';
import { CopyButton } from '../components/CopyButton';
import { useProject, useWorkspaces, useWorkspacePrefix, type AssignmentSummary } from '../hooks/useProjects';
import { formatDate, formatDateTime } from '../lib/format';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { StatusBadge, getStatusDescription } from '../components/StatusBadge';
import { TypeChip } from '../components/TypeChip';
import { ExternalIdBadges } from '../components/ExternalIdBadges';
import { StatCard } from '../components/StatCard';
import { ProgressBar } from '../components/ProgressBar';
import { ContentTabs } from '../components/ContentTabs';
import { SectionCard } from '../components/SectionCard';
import { ViewToggle } from '../components/ViewToggle';
import { EmptyState } from '../components/EmptyState';
import { DependencyGraph } from '../components/DependencyGraph';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import { ProjectTodosPanel } from '../components/ProjectTodosPanel';
import { KanbanBoard, type KanbanColumn } from '../components/KanbanBoard';
import { TableColumnPicker } from '../components/TableColumnPicker';
import { useStatusConfig, getStatusLabel } from '../hooks/useStatusConfig';
import { useTypesConfig, getTypeLabel } from '../hooks/useTypesConfig';
import { useHotkey, useHotkeyScope } from '../hotkeys';
import { coerceProjectDetailView, toFilterValues, type SortField, type SortDirection, type Grouping } from '@shared/view-prefs-schema';
import { saveScopeViewPrefs, useViewPrefs } from '../hooks/useViewPrefs';
import { getAssignmentColumns } from '../lib/kanban';
import { sortAssignments } from '../lib/sortAssignments';
import { filterAssignment } from '../lib/assignmentFilter';
import { SaveViewDialog } from '../components/SaveViewDialog';
import { SavedViewPicker } from '../components/SavedViewPicker';
import { MultiSelect, type MultiSelectOption } from '../components/ui/MultiSelect';
import { DateRangeControl } from '../components/ui/DateRangeControl';
import { useSavedView, createSavedView, updateSavedView } from '../hooks/useSavedViews';
import { captureCurrentView, applyConfig, inferLandingRoute, mergeUpdatedConfig, minimizeDateRange, type DateRangeUiState } from '../lib/savedViews';
import { scopeMatches, type SavedView, type ViewScope } from '@shared/saved-views-schema';
import { useToast, Toaster } from '../components/Toast';

const VALID_TABS = new Set(['overview', 'assignments', 'todos', 'dependencies', 'knowledge']);
const UNKNOWN_TYPE_COLUMN_ID = '__unknown_type__';

export function ProjectDetail() {
  const { slug, workspace } = useParams<{ workspace?: string; slug: string }>();
  const wsPrefix = useWorkspacePrefix();
  const navigate = useNavigate();
  useHotkeyScope('project');
  useHotkey({
    keys: 'a',
    scope: 'project',
    description: 'Create assignment',
    handler: () => navigate(`${wsPrefix}/projects/${slug}/create/assignment`),
  });
  useHotkey({
    keys: 'e',
    scope: 'project',
    description: 'Edit project',
    handler: () => navigate(`${wsPrefix}/projects/${slug}/edit`),
  });
  const { data: project, loading, error, refetch } = useProject(slug);
  const statusConfig = useStatusConfig();
  const typesConfig = useTypesConfig();
  const { data: workspacesData } = useWorkspaces();
  // Tab selection lives in the URL (?tab=<value>) so it stays in sync when
  // react-router reuses this component across project navigations (e.g. the
  // palette jumping from one project's overview to another's todos tab).
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab = tabParam && VALID_TABS.has(tabParam) ? tabParam : 'overview';
  function handleTabChange(value: string) {
    setSearchParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        if (value === 'overview') n.delete('tab');
        else n.set('tab', value);
        return n;
      },
      { replace: true },
    );
  }
  // Namespace the scope key (see AssignmentsPage for rationale).
  const scopeKey = slug ? `p:${slug}` : null;
  const prefs = useViewPrefs(scopeKey);

  const [assignmentView, setAssignmentView] = useState<'kanban' | 'table'>(
    () => coerceProjectDetailView(prefs.defaultView),
  );
  const [statusFilter, setStatusFilter] = useState<string[]>(() => toFilterValues(prefs.filters.status));
  const [assigneeFilter, setAssigneeFilter] = useState<string[]>(() => toFilterValues(prefs.filters.assignee));
  const [priorityFilter, setPriorityFilter] = useState<string[]>(() => toFilterValues(prefs.filters.priority));
  const [typeFilter, setTypeFilter] = useState<string[]>(() => toFilterValues(prefs.filters.type));
  const [tagsFilter, setTagsFilter] = useState<string[]>(() => toFilterValues(prefs.filters.tags));
  // dateRange is a saved-view-only filter (ephemeral, not persisted to view-prefs).
  const [dateRange, setDateRange] = useState<DateRangeUiState | null>(null);
  const [grouping, setGrouping] = useState<Grouping>(() => prefs.grouping);
  const [sortField, setSortField] = useState<SortField>(() => prefs.sortField);
  const [sortDirection, setSortDirection] = useState<SortDirection>(() => prefs.sortDirection);
  // List visibility state — kept for saved-view round-trips even though
  // ProjectDetail doesn't currently expose toggles for these. (Decision: keep
  // captured state symmetric with AssignmentsPage so applying a view here
  // doesn't silently drop the user's choices.)
  const [listSectionVisibility, setListSectionVisibility] = useState<{ collapsed: string[] }>(() => ({ collapsed: [] }));
  const [kanbanColumnVisibility, setKanbanColumnVisibility] = useState<{ hidden: string[] }>(() => ({ hidden: [] }));
  const [tableColumnVisibility, setTableColumnVisibility] = useState<{ hidden: import('@shared/saved-views-schema').TableColumnId[] }>(() => ({ hidden: [] }));

  const [loadedViewId, setLoadedViewId] = useState<string | null>(null);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveAsNewMode, setSaveAsNewMode] = useState(false);
  const { toast, showToast, dismissToast } = useToast();

  const viewScope: ViewScope = {
    kind: 'project',
    slug: slug ?? '',
    workspace: workspace ?? null,
  };

  const loadViewParam = searchParams.get('loadView');
  const { view: pendingView, loading: pendingViewLoading, error: pendingViewError } = useSavedView(loadViewParam);
  const { view: loadedView, loading: loadedViewLoading, error: loadedViewError } = useSavedView(loadedViewId);
  const lastAppliedLoadViewRef = useRef<string | null>(null);

  // Clear loadedViewId if the view disappears (deleted elsewhere). Skip while
  // still loading or on transient fetch error so a brief network blip doesn't
  // drop state.
  useEffect(() => {
    if (loadedViewId && !loadedViewLoading && !loadedViewError && !loadedView) {
      setLoadedViewId(null);
    }
  }, [loadedView, loadedViewError, loadedViewId, loadedViewLoading]);

  // Clear loadedViewId on project or workspace change. The component is reused
  // across /projects/:slug and /w/:workspace/projects/:slug via react-router; a
  // view loaded for one project must not appear as "loaded" on another
  // (Update would PATCH the source view's filters.project, swapping its scope).
  useEffect(() => {
    setLoadedViewId(null);
    lastAppliedLoadViewRef.current = null;
    setDateRange(null); // ephemeral saved-view-only filter; reset only on scope change
  }, [slug, workspace]);

  // Re-hydrate when react-router reuses this component across project switches
  // (the doc comment above on lines 45-47 calls this out for the tab param).
  // Persistence is driven by user-action wrappers below, so these setX calls
  // do not trigger saves — inherited fields stay inherited.
  useEffect(() => {
    setAssignmentView(coerceProjectDetailView(prefs.defaultView));
    setStatusFilter(toFilterValues(prefs.filters.status));
    setAssigneeFilter(toFilterValues(prefs.filters.assignee));
    setPriorityFilter(toFilterValues(prefs.filters.priority));
    setTypeFilter(toFilterValues(prefs.filters.type));
    setTagsFilter(toFilterValues(prefs.filters.tags));
    setGrouping(prefs.grouping);
    setSortField(prefs.sortField);
    setSortDirection(prefs.sortDirection);
  }, [slug, prefs.defaultView, prefs.filters.status, prefs.filters.assignee, prefs.filters.priority, prefs.filters.type, prefs.filters.tags, prefs.grouping, prefs.sortField, prefs.sortDirection]);

  const persistField = useCallback(
    (patch: Parameters<typeof saveScopeViewPrefs>[1]) => {
      if (!scopeKey) return;
      saveScopeViewPrefs(scopeKey, patch).catch((err) => {
        console.warn('Failed to persist project view prefs:', err);
      });
    },
    [scopeKey],
  );

  const handleSetAssignmentView = useCallback(
    (v: 'kanban' | 'table') => {
      setAssignmentView(v);
      persistField({ defaultView: v });
    },
    [persistField],
  );
  // Multi-value: persist the explicit array (incl. [] to clear — the prefs
  // deep-merge treats omission as "preserve", so clearing must be explicit).
  const handleSetStatusFilter = useCallback(
    (v: string[]) => {
      setStatusFilter(v);
      persistField({ filters: { status: v } });
    },
    [persistField],
  );
  const handleSetAssigneeFilter = useCallback(
    (v: string[]) => {
      setAssigneeFilter(v);
      persistField({ filters: { assignee: v } });
    },
    [persistField],
  );
  const handleSetPriorityFilter = useCallback(
    (v: string[]) => {
      setPriorityFilter(v);
      persistField({ filters: { priority: v } });
    },
    [persistField],
  );
  const handleSetTypeFilter = useCallback(
    (v: string[]) => {
      setTypeFilter(v);
      persistField({ filters: { type: v } });
    },
    [persistField],
  );
  const handleSetTagsFilter = useCallback(
    (v: string[]) => {
      setTagsFilter(v);
      persistField({ filters: { tags: v } });
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

  const buildViewState = useCallback(
    () => ({
      // ProjectDetail uses only 'kanban' | 'table'. The saved view ViewMode union
      // includes 'list'; either value here is valid. Round-trip applies
      // coerceProjectDetailView on the way back in.
      viewMode: assignmentView,
      filters: {
        status: statusFilter,
        priority: priorityFilter,
        type: typeFilter,
        assignee: assigneeFilter,
        tags: tagsFilter,
        // project filter is forced via context.projectSlug below — value here is ignored
        project: 'all',
        activity: 'all' as const,
        dateRange: minimizeDateRange(dateRange),
      },
      sortField,
      sortDirection,
      listSectionVisibility,
      kanbanColumnVisibility,
      tableColumnVisibility,
    }),
    [
      assignmentView,
      statusFilter,
      priorityFilter,
      typeFilter,
      assigneeFilter,
      tagsFilter,
      dateRange,
      sortField,
      sortDirection,
      listSectionVisibility,
      kanbanColumnVisibility,
      tableColumnVisibility,
    ],
  );

  const applyViewToState = useCallback(
    (v: SavedView) => {
      applyConfig(v, {
        setViewMode: (mode) => setAssignmentView(coerceProjectDetailView(mode)),
        setStatusFilter: handleSetStatusFilter,
        setPriorityFilter: handleSetPriorityFilter,
        setTypeFilter: handleSetTypeFilter,
        setAssigneeFilter: handleSetAssigneeFilter,
        setTagsFilter: handleSetTagsFilter,
        setDateRange,
        // setProjectFilter / setSearch intentionally omitted — slug is URL-derived
        // and ProjectDetail has no search box (search-bearing views route elsewhere).
        setSortField: handleSetSortField,
        setSortDirection: handleSetSortDirection,
        setListSectionVisibility,
        setKanbanColumnVisibility,
        setTableColumnVisibility,
      });
      setLoadedViewId(v.id);
    },
    [
      handleSetStatusFilter,
      handleSetPriorityFilter,
      handleSetTypeFilter,
      handleSetAssigneeFilter,
      handleSetTagsFilter,
      handleSetSortField,
      handleSetSortDirection,
    ],
  );

  const handleApplyView = useCallback(
    (v: SavedView) => {
      applyViewToState(v);
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
          context: { workspace: workspace ?? null, projectSlug: slug ?? null },
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
        showToast(err instanceof Error ? err.message : 'Failed to save view', 'error');
        throw err;
      }
    },
    [buildViewState, setSearchParams, showToast, slug, workspace],
  );

  const handleUpdateView = useCallback(async () => {
    if (!loadedViewId || !loadedView) return;
    try {
      // Preserve the LOADED view's project scope on Update — do NOT force the
      // route slug (Save/Update never silently changes a view). A global view
      // applied here stays global; a [slug]-scoped one stays scoped. (New Save
      // below intentionally scopes to this project via slug.)
      const loadedProject = toFilterValues(loadedView.config.filters.project)[0] ?? null;
      const payload = captureCurrentView({
        name: loadedView.name,
        context: { workspace: workspace ?? null, projectSlug: loadedProject },
        state: buildViewState(),
      });
      // Merge onto the existing config: visibility from the live capture, unknown
      // top-level + filter keys preserved from the loaded view.
      const config = mergeUpdatedConfig(loadedView.config, payload.config, payload.config);
      await updateSavedView(loadedViewId, { config });
      showToast('View updated', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update view', 'error');
    }
  }, [buildViewState, loadedView, loadedViewId, showToast, workspace]);

  useEffect(() => {
    if (!loadViewParam) {
      lastAppliedLoadViewRef.current = null;
      return;
    }
    if (lastAppliedLoadViewRef.current === loadViewParam) return;
    if (loadedViewId && loadedViewId !== loadViewParam) {
      setLoadedViewId(null);
    }
    if (pendingViewLoading) return;
    if (pendingViewError) {
      // Don't mark as applied — a later refetch may succeed. The param stays
      // in the URL so recovery is automatic on next fetch.
      showToast("Couldn't load saved view — try again", 'error');
      return;
    }
    if (pendingView) {
      lastAppliedLoadViewRef.current = loadViewParam;
      // ProjectDetail can't render every view (no activity setter; project is
      // pinned to the URL slug; foreign-workspace views belong elsewhere). If the
      // view isn't project-scope compatible — e.g. a legacy project+activity view,
      // a multi-project view, or a different-workspace view reached via a bookmarked
      // /projects/<slug>?loadView= URL — redirect to its own faithful surface via
      // inferLandingRoute (correct prefix from the VIEW's workspace) instead of
      // silently dropping filters here.
      if (!scopeMatches(pendingView, { kind: 'project', slug: slug ?? '', workspace: workspace ?? null })) {
        navigate(inferLandingRoute(pendingView), { replace: true });
        return;
      }
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
    navigate,
    slug,
    workspace,
  ]);

  function handleSort(field: SortField) {
    if (sortField === field) {
      const next: SortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      handleSetSortDirection(next);
    } else {
      handleSetSortField(field);
      handleSetSortDirection('asc');
    }
  }

  const dependencyRoutes = useMemo(
    () => project ? Object.fromEntries(
      project.assignments.flatMap((assignment) => {
        const route = `${wsPrefix}/projects/${project.slug}/assignments/${assignment.slug}`;
        return [
          [assignment.slug, route],
          [assignment.title, route],
        ];
      }),
    ) : {},
    [project],
  );

  async function handleStatusOverride(status: string | null) {
    await fetch(`/api/projects/${slug}/status-override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    refetch();
  }

  async function handleArchiveProject(archived: boolean) {
    try {
      const res = await fetch(`/api/projects/${slug}/${archived ? 'archive' : 'unarchive'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        showToast(payload?.error || `HTTP ${res.status}`, 'error');
        return;
      }
      refetch();
      showToast(archived ? 'Project archived' : 'Project restored', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update archive state', 'error');
    }
  }

  async function handleMoveWorkspace(workspace: string | null) {
    await fetch(`/api/projects/${slug}/move-workspace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace }),
    });
    refetch();
  }

  if (loading) {
    return <LoadingState label="Loading project workspace…" />;
  }

  if (error || !project) {
    return <ErrorState error={error || 'Project not found.'} />;
  }

  // Assignee options: the sentinel-aware shared model (null -> '__unassigned__'),
  // matching AssignmentsPage and filterAssignment, so an Unassigned saved view
  // round-trips here. MultiSelect injects any orphan selection not in this list.
  const assigneeOptions: MultiSelectOption[] = (() => {
    const names = new Set<string>();
    for (const a of project.assignments) {
      if (a.assignee) names.add(a.assignee);
    }
    // Always offer Unassigned so a user can proactively filter/save for it.
    const opts: MultiSelectOption[] = [{ value: '__unassigned__', label: 'Unassigned' }];
    for (const n of Array.from(names).sort()) opts.push({ value: n, label: n });
    return opts;
  })();
  // Centralized predicate (multi-value + sentinel-aware). No workspace/project/
  // activity criteria here — ProjectDetail is already scoped to its slug.
  const tagOptions: MultiSelectOption[] = Array.from(
    new Set(project.assignments.flatMap((a) => a.tags ?? [])),
  )
    .sort()
    .map((t) => ({ value: t, label: t }));
  const filteredAssignments = project.assignments.filter((assignment) =>
    filterAssignment(assignment, {
      status: statusFilter,
      priority: priorityFilter,
      type: typeFilter,
      assignee: assigneeFilter,
      tags: tagsFilter,
      dateRange: minimizeDateRange(dateRange),
    }),
  );
  const sortedAssignments = sortAssignments(filteredAssignments, sortField, sortDirection);
  const knownTypeIds = new Set(typesConfig.definitions.map((d) => d.id));
  const kanbanColumns: KanbanColumn[] =
    grouping === 'type'
      ? [
          ...typesConfig.definitions.map((def) => ({
            id: def.id,
            title: getTypeLabel(typesConfig, def.id),
            description: def.description,
          })),
          ...(filteredAssignments.some((a) => !a.type || !knownTypeIds.has(a.type))
            ? [
                {
                  id: UNKNOWN_TYPE_COLUMN_ID,
                  title: 'Other',
                  description: 'Assignments with no recognized type.',
                },
              ]
            : []),
        ]
      : getAssignmentColumns(statusConfig.order).map((id) => ({
          id,
          title: getStatusLabel(statusConfig, id),
          description: getStatusDescription(id),
        }));

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
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge status={project.status} />
        {project.statusOverride && (
          <button
            type="button"
            className="shell-action border-warning-foreground/40 text-warning-foreground"
            onClick={() => handleStatusOverride(null)}
            title="Clear manual status override and return to derived status"
          >
            Clear Override
          </button>
        )}
        <select
          className="shell-action appearance-none bg-transparent text-sm"
          value=""
          onChange={(e) => {
            if (e.target.value) handleStatusOverride(e.target.value);
          }}
          title="Override project status"
        >
          <option value="">Set Status…</option>
          {statusConfig.statuses.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
          <option value="active">Active</option>
        </select>
        <button
          type="button"
          className="shell-action"
          onClick={() => handleArchiveProject(!project.archived)}
          title={
            project.archived
              ? 'Restore this project and its cascade-hidden assignments'
              : 'Archive this project (hides it and its assignments from normal views)'
          }
        >
          {project.archived ? 'Restore' : 'Archive'}
        </button>
        {workspacesData && workspacesData.workspaces.length > 0 && (
          <select
            className="shell-action appearance-none bg-transparent text-sm"
            value=""
            onChange={(e) => {
              if (e.target.value === '_ungrouped') handleMoveWorkspace(null);
              else if (e.target.value) handleMoveWorkspace(e.target.value);
            }}
            title="Move project to a different workspace"
          >
            <option value="">Move to Workspace…</option>
            {workspacesData.workspaces
              .filter((w) => w !== project.workspace)
              .map((w) => (
                <option key={w} value={w}>{w}</option>
              ))}
            {project.workspace && <option value="_ungrouped">Ungrouped</option>}
          </select>
        )}
        <Link className="shell-action" to={`${wsPrefix}/projects/${project.slug}/edit`}>
          <SquarePen className="h-4 w-4" />
          <span>Edit Project</span>
        </Link>
        <Link className="shell-action bg-foreground text-background hover:opacity-90" to={`${wsPrefix}/projects/${project.slug}/create/assignment`}>
          <Plus className="h-4 w-4" />
          <span>New Assignment</span>
        </Link>
        <ExternalIdBadges externalIds={project.externalIds} />
        <span className="text-xs text-muted-foreground">Created {formatDate(project.created)}. Last source update {formatDateTime(project.updated)}.</span>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Assignments" value={project.progress.total} />
        <StatCard label="In Progress" value={project.progress['in_progress'] ?? 0} tone="info" />
        <StatCard label="Review" value={project.progress['review'] ?? 0} tone="info" />
        <StatCard label="Blocked" value={project.progress['blocked'] ?? 0} tone="warn" />
        <StatCard label="Completed" value={project.progress['completed'] ?? 0} tone="success" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
        <div className="space-y-4">
          <ContentTabs
            value={tab}
            onValueChange={handleTabChange}
            items={[
              {
                value: 'overview',
                label: 'Overview',
                content: (
                  <div className="space-y-5">
                    <SectionCard title="Project Overview">
                      <MarkdownRenderer
                        content={project.body}
                        emptyState="This project does not have overview content yet."
                      />
                    </SectionCard>
                  </div>
                ),
              },
              {
                value: 'assignments',
                label: 'Assignments',
                // Archived assignments are hidden from the table; don't inflate the count with them.
                count: project.assignments.filter((a) => !a.archived).length,
                content: (
                  <div className="space-y-5">
                    <SectionCard
                      title="Assignment Queue"
                      description="Board and table views over the source assignment files."
                      actions={
                        <div className="flex flex-wrap items-center gap-2">
                          <MultiSelect
                            ariaLabel="Status filter"
                            className="max-w-[170px]"
                            allLabel="All statuses"
                            options={statusConfig.statuses.map((s) => ({ value: s.id, label: s.label }))}
                            value={statusFilter}
                            onChange={handleSetStatusFilter}
                          />
                          <MultiSelect
                            ariaLabel="Assignee filter"
                            className="max-w-[170px]"
                            allLabel="All assignees"
                            options={assigneeOptions}
                            value={assigneeFilter}
                            onChange={handleSetAssigneeFilter}
                          />
                          <MultiSelect
                            ariaLabel="Priority filter"
                            className="max-w-[170px]"
                            allLabel="All priorities"
                            options={[
                              { value: 'critical', label: 'Critical' },
                              { value: 'high', label: 'High' },
                              { value: 'medium', label: 'Medium' },
                              { value: 'low', label: 'Low' },
                            ]}
                            value={priorityFilter}
                            onChange={handleSetPriorityFilter}
                          />
                          <MultiSelect
                            ariaLabel="Type filter"
                            className="max-w-[170px]"
                            allLabel="All types"
                            options={typesConfig.definitions.map((t) => ({ value: t.id, label: getTypeLabel(typesConfig, t.id) }))}
                            value={typeFilter}
                            onChange={handleSetTypeFilter}
                          />
                          <MultiSelect
                            ariaLabel="Tags filter"
                            className="max-w-[170px]"
                            allLabel="Any tags"
                            options={tagOptions}
                            value={tagsFilter}
                            onChange={handleSetTagsFilter}
                          />
                          <DateRangeControl
                            className="max-w-[190px]"
                            value={dateRange}
                            onChange={setDateRange}
                          />
                          {assignmentView === 'kanban' && (
                            <select value={grouping === 'type' ? 'type' : 'status'} onChange={(event) => handleSetGrouping(event.target.value as Grouping)} className="editor-input max-w-[170px]" title="Group kanban by">
                              <option value="status">Group: Status</option>
                              <option value="type">Group: Type</option>
                            </select>
                          )}
                          <ViewToggle
                            value={assignmentView}
                            onChange={(value) => handleSetAssignmentView(value as 'kanban' | 'table')}
                            options={[
                              { value: 'kanban', label: 'Kanban' },
                              { value: 'table', label: 'Table' },
                            ]}
                          />
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
                        </div>
                      }
                    >
                      {filteredAssignments.length === 0 ? (
                        <EmptyState
                          title="No assignments match these filters"
                          description="Clear the current filters or create a new assignment for this project."
                          actions={
                            <Link className="shell-action bg-foreground text-background hover:opacity-90" to={`${wsPrefix}/projects/${project.slug}/create/assignment`}>
                              Create Assignment
                            </Link>
                          }
                        />
                      ) : assignmentView === 'kanban' ? (
                        <KanbanBoard
                          columns={kanbanColumns}
                          items={sortedAssignments}
                          getItemId={(a) => a.slug}
                          getColumnId={(a) =>
                            grouping === 'type'
                              ? a.type && knownTypeIds.has(a.type)
                                ? a.type
                                : UNKNOWN_TYPE_COLUMN_ID
                              : a.status
                          }
                          dragDisabled
                          renderCard={(item) => (
                            <AssignmentCard projectSlug={project.slug} assignment={item} />
                          )}
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
                        />
                      ) : (
                        (() => {
                          const hiddenCols = new Set(tableColumnVisibility.hidden);
                          // `title` is non-hideable (TableColumnPicker NON_HIDEABLE). Force-show it
                          // defensively so a persisted view with `hidden: ['title']` doesn't trap
                          // the user — the picker can't restore it.
                          const showCol = (id: import('@shared/saved-views-schema').TableColumnId) => id === 'title' || !hiddenCols.has(id);
                          return (
                        <div className="overflow-x-auto">
                          <div className="mb-3 flex items-center justify-end">
                            <TableColumnPicker
                              visibility={tableColumnVisibility}
                              onChange={setTableColumnVisibility}
                            />
                          </div>
                          <table className="w-full min-w-[720px] text-left text-sm">
                            <thead>
                              <tr className="border-b border-border/60 text-muted-foreground">
                                {showCol('title') ? <SortHeader field="title">Assignment</SortHeader> : null}
                                {showCol('status') ? <SortHeader field="status">Status</SortHeader> : null}
                                <th className="pb-3 font-medium">Type</th>
                                {showCol('priority') ? <SortHeader field="priority">Priority</SortHeader> : null}
                                {showCol('assignee') ? <SortHeader field="assignee">Assignee</SortHeader> : null}
                                {showCol('dependencies') ? <SortHeader field="dependencies">Dependencies</SortHeader> : null}
                                {showCol('created') ? <SortHeader field="created">Created</SortHeader> : null}
                                {showCol('updated') ? <SortHeader field="updated">Updated</SortHeader> : null}
                              </tr>
                            </thead>
                            <tbody>
                              {sortedAssignments.map((assignment) => (
                                <tr key={assignment.slug} className="border-b border-border/50 last:border-0">
                                  {showCol('title') ? (
                                  <td className="py-4">
                                    <Link
                                      to={`${wsPrefix}/projects/${project.slug}/assignments/${assignment.slug}`}
                                      className="font-semibold text-foreground hover:text-primary"
                                    >
                                      {assignment.title}
                                    </Link>
                                  </td>
                                  ) : null}
                                  {showCol('status') ? <td className="py-4"><StatusBadge status={assignment.status} /></td> : null}
                                  <td className="py-4"><TypeChip type={assignment.type} compact /></td>
                                  {showCol('priority') ? <td className="py-4 capitalize text-muted-foreground">{assignment.priority}</td> : null}
                                  {showCol('assignee') ? <td className="py-4 text-muted-foreground">{assignment.assignee ?? '\u2014'}</td> : null}
                                  {showCol('dependencies') ? <td className="py-4 text-muted-foreground">{assignment.dependsOn.length}</td> : null}
                                  {showCol('created') ? <td className="py-4 text-muted-foreground">{formatDate(assignment.created)}</td> : null}
                                  {showCol('updated') ? <td className="py-4 text-muted-foreground">{formatDate(assignment.updated)}</td> : null}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                          );
                        })()
                      )}
                    </SectionCard>
                  </div>
                ),
              },
              {
                value: 'todos',
                label: 'Todos',
                content: <ProjectTodosPanel projectId={project.slug} />,
              },
              {
                value: 'dependencies',
                label: 'Dependencies',
                content: project.dependencyGraph ? (
                  <SectionCard
                    title="Dependency Graph"
                    description="Rendered from the derived graph when available, with a source-based fallback."
                  >
                    <DependencyGraph definition={project.dependencyGraph} nodeRoutes={dependencyRoutes} />
                  </SectionCard>
                ) : (
                  <EmptyState
                    title="No dependency graph yet"
                    description="Dependencies appear here once assignments declare dependsOn relationships."
                  />
                ),
              },
              {
                value: 'knowledge',
                label: 'Knowledge',
                content: (
                  <div className="grid gap-3 lg:grid-cols-2">
                    <SectionCard
                      title="Resources"
                      description="Shared project references."
                      actions={
                        <Link
                          className="shell-action"
                          to={`/resources/new?project=${project.slug}`}
                        >
                          <Plus className="h-4 w-4" />
                          <span>New Resource</span>
                        </Link>
                      }
                    >
                      {project.resources.length === 0 ? (
                        <EmptyState
                          title="No resources yet"
                          description="Resources live at the project level and stay available to every assignment."
                        />
                      ) : (
                        <div className="space-y-3">
                          {project.resources.map((resource) => (
                            <Link
                              key={resource.slug}
                              to={`/projects/${project.slug}/resources/${resource.slug}`}
                              className="block rounded-md border border-border/60 bg-background/80 p-3 transition hover:border-primary/40"
                            >
                              <h3 className="font-semibold text-foreground">{resource.name}</h3>
                              <p className="mt-2 text-sm text-muted-foreground">
                                {resource.category} · {resource.source}
                              </p>
                            </Link>
                          ))}
                        </div>
                      )}
                    </SectionCard>

                    <SectionCard
                      title="Memories"
                      description="Learnings and patterns captured during the project."
                      actions={
                        <Link
                          className="shell-action"
                          to={`/memories/new?project=${project.slug}`}
                        >
                          <Plus className="h-4 w-4" />
                          <span>New Memory</span>
                        </Link>
                      }
                    >
                      {project.memories.length === 0 ? (
                        <EmptyState
                          title="No memories yet"
                          description="Memories capture patterns discovered during execution so later assignments can reuse them."
                        />
                      ) : (
                        <div className="space-y-3">
                          {project.memories.map((memory) => (
                            <Link
                              key={memory.slug}
                              to={`/projects/${project.slug}/memories/${memory.slug}`}
                              className="block rounded-md border border-border/60 bg-background/80 p-3 transition hover:border-primary/40"
                            >
                              <h3 className="font-semibold text-foreground">{memory.name}</h3>
                              <p className="mt-2 text-sm text-muted-foreground">
                                {memory.scope} · {memory.source}
                              </p>
                            </Link>
                          ))}
                        </div>
                      )}
                    </SectionCard>
                  </div>
                ),
              },
            ]}
          />
        </div>

        <div className="space-y-5">
          <SectionCard title="Progress Summary">
            <ProgressBar progress={project.progress} showLegend />
          </SectionCard>

          <SectionCard title="Attention">
            <dl className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Blocked</dt>
                <dd className="font-semibold text-foreground">{project.needsAttention.blockedCount}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Failed</dt>
                <dd className="font-semibold text-foreground">{project.needsAttention.failedCount}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Unanswered questions</dt>
                <dd className="font-semibold text-foreground">{project.needsAttention.openQuestions}</dd>
              </div>
            </dl>
          </SectionCard>

          <SectionCard title="Quick Links">
            <div className="space-y-2 text-sm">
              <Link className="flex items-center gap-2 text-primary hover:underline" to={`${wsPrefix}/projects/${project.slug}/edit`}>
                <SquarePen className="h-4 w-4" />
                Edit project source
              </Link>
              <Link className="flex items-center gap-2 text-primary hover:underline" to={`${wsPrefix}/projects/${project.slug}/create/assignment`}>
                <Plus className="h-4 w-4" />
                Create assignment
              </Link>
              <Link className="flex items-center gap-2 text-primary hover:underline" to="/help">
                <BookOpenText className="h-4 w-4" />
                Review project rules
              </Link>
              <button
                type="button"
                onClick={() => handleTabChange('dependencies')}
                className="flex items-center gap-2 text-primary hover:underline"
              >
                <GitBranch className="h-4 w-4" />
                Jump to dependencies
              </button>
            </div>
          </SectionCard>

          {project.archived ? (
            <SectionCard title="Archive Metadata">
              <p className="text-sm leading-6 text-muted-foreground">
                Archived {project.archivedAt ? formatDateTime(project.archivedAt) : 'with no timestamp recorded'}.
              </p>
              {project.archivedReason ? (
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{project.archivedReason}</p>
              ) : null}
            </SectionCard>
          ) : null}
        </div>
      </div>

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
    </div>
  );
}

function AssignmentCard({
  projectSlug,
  assignment,
}: {
  projectSlug: string;
  assignment: AssignmentSummary;
}) {
  const wsPrefix = useWorkspacePrefix();
  return (
    <Link
      to={`${wsPrefix}/projects/${projectSlug}/assignments/${assignment.slug}`}
      className="vp-card block rounded-lg border border-border/60 bg-background/80 p-3 transition hover:border-primary/40"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="font-semibold text-foreground">{assignment.title}</h3>
          <p className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground/70" title={assignment.id}>
            {assignment.id.slice(0, 8)}
            <span onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
              <CopyButton value={assignment.id} />
            </span>
          </p>
          <p className="text-sm text-muted-foreground">Updated {formatDate(assignment.updated)}</p>
        </div>
        <StatusBadge status={assignment.status} />
      </div>
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
    </Link>
  );
}
