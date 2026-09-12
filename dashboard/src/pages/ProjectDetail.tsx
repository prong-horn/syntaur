import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { BookOpenText, ChevronDown, ChevronUp, GitBranch, Plus, SquarePen } from 'lucide-react';
import { CopyButton } from '../components/CopyButton';
import { ProjectWorkflowSection } from '../components/ProjectWorkflowSection';
import { WorkflowSwimlanes } from '../components/WorkflowSwimlanes';
import { useProject, type TicketSummary } from '../hooks/useProjects';
import { formatDate, formatDateTime } from '../lib/format';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { StatusBadge, getStatusDescription } from '../components/StatusBadge';
import { TicketStatusPill } from '../components/TicketStatusPill';
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
import { KanbanBoard, type KanbanColumn } from '../components/KanbanBoard';
import { TableColumnPicker } from '../components/TableColumnPicker';
import { useStatusConfig, getStatusLabel } from '../hooks/useStatusConfig';
import { useTypesConfig, getTypeLabel } from '../hooks/useTypesConfig';
import { useHotkey, useHotkeyScope } from '../hotkeys';
import { coerceProjectDetailView, toFilterValues, type SortField, type SortDirection, type Grouping } from '@shared/view-prefs-schema';
import { saveScopeViewPrefs, useViewPrefs } from '../hooks/useViewPrefs';
import { getTicketColumns } from '../lib/kanban';
import { sortTickets } from '../lib/sortTickets';
import { filterTicket } from '../lib/ticketFilter';
import { MultiSelect, type MultiSelectOption } from '../components/ui/MultiSelect';
import { DateRangeControl } from '../components/ui/DateRangeControl';
import { minimizeDateRange, type DateRangeUiState } from '../lib/dateRange';
import type { TableColumnId } from '@shared/view-prefs-schema';
import { useToast, Toaster } from '../components/Toast';

const VALID_TABS = new Set(['overview', 'tickets', 'workflow', 'dependencies']);
const UNKNOWN_TYPE_COLUMN_ID = '__unknown_type__';

export function ProjectDetail() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  useHotkeyScope('project');
  useHotkey({
    keys: 'a',
    scope: 'project',
    description: 'Create ticket',
    handler: () => navigate(`/projects/${slug}/create/ticket`),
  });
  useHotkey({
    keys: 'e',
    scope: 'project',
    description: 'Edit project',
    handler: () => navigate(`/projects/${slug}/edit`),
  });
  const { data: project, loading, error, refetch } = useProject(slug);
  const statusConfig = useStatusConfig();
  const typesConfig = useTypesConfig();
  // Tab selection lives in the URL (?tab=<value>) so it stays in sync when
  // react-router reuses this component across project navigations (e.g. the
  // palette jumping from one project's overview to another's tab).
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
  // Namespace the scope key (see TicketsPage for rationale).
  const scopeKey = slug ? `p:${slug}` : null;
  const prefs = useViewPrefs(scopeKey);

  const [ticketView, setTicketView] = useState<'kanban' | 'table'>(
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
  const [kanbanColumnVisibility, setKanbanColumnVisibility] = useState<{ hidden: string[] }>(() => ({ hidden: [] }));
  const [tableColumnVisibility, setTableColumnVisibility] = useState<{ hidden: TableColumnId[] }>(() => ({ hidden: [] }));

  const { toast, showToast, dismissToast } = useToast();

  useEffect(() => {
    setDateRange(null);
  }, [slug]);

  // Re-hydrate when react-router reuses this component across project switches
  // (the doc comment above on lines 45-47 calls this out for the tab param).
  // Persistence is driven by user-action wrappers below, so these setX calls
  // do not trigger saves — inherited fields stay inherited.
  useEffect(() => {
    setTicketView(coerceProjectDetailView(prefs.defaultView));
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

  const handleSetTicketView = useCallback(
    (v: 'kanban' | 'table') => {
      setTicketView(v);
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
      project.tickets.flatMap((ticket) => {
        const route = `/projects/${project.slug}/tickets/${ticket.slug}`;
        return [
          [ticket.slug, route],
          [ticket.title, route],
        ];
      }),
    ) : {},
    [project],
  );

  // Guards the project action controls (status override / archive / move) so a
  // double-click can't fire duplicate mutations while one is in flight.
  const [actionPending, setActionPending] = useState(false);

  async function handleStatusOverride(status: string | null) {
    setActionPending(true);
    try {
      const res = await fetch(`/api/projects/${slug}/status-override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        showToast(payload?.error || `HTTP ${res.status}`, 'error');
        return;
      }
      refetch();
      showToast(status ? 'Status override set' : 'Status override cleared', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update status', 'error');
    } finally {
      setActionPending(false);
    }
  }

  async function handleArchiveProject(archived: boolean) {
    setActionPending(true);
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
    } finally {
      setActionPending(false);
    }
  }

  if (loading) {
    return <LoadingState label="Loading project…" />;
  }

  if (error || !project) {
    return <ErrorState error={error || 'Project not found.'} />;
  }

  // Assignee options: the sentinel-aware shared model (null -> '__unassigned__'),
  // matching TicketsPage and filterTicket, so an Unassigned saved view
  // round-trips here. MultiSelect injects any orphan selection not in this list.
  const assigneeOptions: MultiSelectOption[] = (() => {
    const names = new Set<string>();
    for (const a of project.tickets) {
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
    new Set(project.tickets.flatMap((a) => a.tags ?? [])),
  )
    .sort()
    .map((t) => ({ value: t, label: t }));
  const filteredTickets = project.tickets.filter((ticket) =>
    filterTicket(ticket, {
      status: statusFilter,
      priority: priorityFilter,
      type: typeFilter,
      assignee: assigneeFilter,
      tags: tagsFilter,
      dateRange: minimizeDateRange(dateRange),
    }),
  );
  const sortedTickets = sortTickets(filteredTickets, sortField, sortDirection);
  const knownTypeIds = new Set(typesConfig.definitions.map((d) => d.id));
  const kanbanColumns: KanbanColumn[] =
    grouping === 'type'
      ? [
          ...typesConfig.definitions.map((def) => ({
            id: def.id,
            title: getTypeLabel(typesConfig, def.id),
            description: def.description,
          })),
          ...(filteredTickets.some((a) => !a.type || !knownTypeIds.has(a.type))
            ? [
                {
                  id: UNKNOWN_TYPE_COLUMN_ID,
                  title: 'Other',
                  description: 'Tickets with no recognized type.',
                },
              ]
            : []),
        ]
      : getTicketColumns(statusConfig.order).map((id) => ({
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
            className="shell-action border-warning-foreground/40 text-warning-foreground disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => handleStatusOverride(null)}
            disabled={actionPending}
            title="Clear manual status override and return to derived status"
          >
            Clear Override
          </button>
        )}
        <select
          className="shell-action appearance-none bg-transparent text-sm disabled:cursor-not-allowed disabled:opacity-50"
          value=""
          disabled={actionPending}
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
          className="shell-action disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => handleArchiveProject(!project.archived)}
          disabled={actionPending}
          title={
            project.archived
              ? 'Restore this project and its cascade-hidden tickets'
              : 'Archive this project (hides it and its tickets from normal views)'
          }
        >
          {project.archived ? 'Restore' : 'Archive'}
        </button>
        <Link className="shell-action" to={`/projects/${project.slug}/edit`}>
          <SquarePen className="h-4 w-4" />
          <span>Edit Project</span>
        </Link>
        {/* "New Ticket" is the persistent primary CTA in the TopBar on every
            project page (and a Quick Link below) — no need to repeat it here. */}
        <ExternalIdBadges externalIds={project.externalIds} />
        <span className="text-xs text-muted-foreground">Created {formatDate(project.created)}. Last source update {formatDateTime(project.updated)}.</span>
      </div>

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 xl:grid-cols-5">
        <StatCard label="Tickets" value={project.progress.total} />
        <StatCard label="In Progress" value={project.progress['in_progress'] ?? 0} tone="info" />
        <StatCard label="Review" value={project.progress['review'] ?? 0} tone="info" />
        <StatCard label="Blocked" value={project.progress['blocked'] ?? 0} tone="warn" />
        <StatCard label="Completed" value={project.progress['completed'] ?? 0} tone="success" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
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
                      {project.body && project.body.trim() ? (
                        <MarkdownRenderer content={project.body} />
                      ) : (
                        <EmptyState
                          title="No overview yet"
                          description="Add a short summary so collaborators and agents know what this project is about."
                          actions={
                            <Link
                              className="shell-action shell-action--cta"
                              to={`/projects/${project.slug}/edit`}
                            >
                              <SquarePen className="h-4 w-4" />
                              <span>Add overview</span>
                            </Link>
                          }
                        />
                      )}
                    </SectionCard>
                  </div>
                ),
              },
              {
                value: 'tickets',
                label: 'Tickets',
                // Archived tickets are hidden from the table; don't inflate the count with them.
                count: project.tickets.filter((a) => !a.archived).length,
                content: (
                  <div className="space-y-5">
                    <SectionCard
                      title="Ticket Queue"
                      description="Board and table views over the source ticket files."
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
                          {ticketView === 'kanban' && (
                            <select value={grouping === 'type' || grouping === 'workflow' ? grouping : 'status'} onChange={(event) => handleSetGrouping(event.target.value as Grouping)} className="editor-input max-w-[170px]" title="Group kanban by">
                              <option value="status">Group: Status</option>
                              <option value="type">Group: Type</option>
                              <option value="workflow">Group: Workflow</option>
                            </select>
                          )}
                          <ViewToggle
                            value={ticketView}
                            onChange={(value) => handleSetTicketView(value as 'kanban' | 'table')}
                            options={[
                              { value: 'kanban', label: 'Kanban' },
                              { value: 'table', label: 'Table' },
                            ]}
                          />
                        </div>
                      }
                    >
                      {filteredTickets.length === 0 ? (
                        <EmptyState
                          title="No tickets match these filters"
                          description="Clear the current filters or create a new ticket for this project."
                          actions={
                            <Link className="shell-action shell-action--cta" to={`/projects/${project.slug}/create/ticket`}>
                              Create Ticket
                            </Link>
                          }
                        />
                      ) : ticketView === 'kanban' && grouping === 'workflow' ? (
                        <WorkflowSwimlanes
                          items={sortedTickets}
                          getItemId={(a) => a.slug}
                          renderCard={(item) => (
                            <TicketCard projectSlug={project.slug} ticket={item} onTicketChange={() => refetch()} />
                          )}
                          emptyMessage={(column) => `No ${column.title.toLowerCase()} tickets.`}
                        />
                      ) : ticketView === 'kanban' ? (
                        <KanbanBoard
                          columns={kanbanColumns}
                          items={sortedTickets}
                          getItemId={(a) => a.slug}
                          getColumnId={(a) =>
                            grouping === 'type'
                              ? a.type && knownTypeIds.has(a.type)
                                ? a.type
                                : UNKNOWN_TYPE_COLUMN_ID
                              : a.status
                          }
                          dragDisabled
                          boundedColumns
                          renderCard={(item) => (
                            <TicketCard projectSlug={project.slug} ticket={item} onTicketChange={() => refetch()} />
                          )}
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
                        />
                      ) : (
                        (() => {
                          const hiddenCols = new Set(tableColumnVisibility.hidden);
                          // `title` is non-hideable (TableColumnPicker NON_HIDEABLE). Force-show it
                          // defensively so a persisted view with `hidden: ['title']` doesn't trap
                          // the user — the picker can't restore it.
                          const showCol = (id: TableColumnId) => id === 'title' || !hiddenCols.has(id);
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
                                {showCol('title') ? <SortHeader field="title">Ticket</SortHeader> : null}
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
                              {sortedTickets.map((ticket) => (
                                <tr key={ticket.slug} className="border-b border-border/50 last:border-0">
                                  {showCol('title') ? (
                                  <td className="py-4">
                                    <Link
                                      to={`/projects/${project.slug}/tickets/${ticket.slug}`}
                                      className="font-semibold text-foreground hover:text-primary"
                                    >
                                      {ticket.title}
                                    </Link>
                                  </td>
                                  ) : null}
                                  {showCol('status') ? <td className="py-4"><TicketStatusPill projectSlug={project.slug} slug={ticket.slug} status={ticket.status} title={ticket.title} className="max-w-[150px]" onChange={() => refetch()} /></td> : null}
                                  <td className="py-4"><TypeChip type={ticket.type} compact /></td>
                                  {showCol('priority') ? <td className="py-4 capitalize text-muted-foreground">{ticket.priority}</td> : null}
                                  {showCol('assignee') ? <td className="py-4 text-muted-foreground">{ticket.assignee ?? '\u2014'}</td> : null}
                                  {showCol('dependencies') ? <td className="py-4 text-muted-foreground">{ticket.dependsOn.length}</td> : null}
                                  {showCol('created') ? <td className="py-4 text-muted-foreground">{formatDate(ticket.created)}</td> : null}
                                  {showCol('updated') ? <td className="py-4 text-muted-foreground">{formatDate(ticket.updated)}</td> : null}
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
                value: 'workflow',
                label: 'Workflow',
                content: (
                  <ProjectWorkflowSection
                    projectSlug={project.slug}
                    defaultWorkflow={project.defaultWorkflow}
                    workflowByType={project.workflowByType}
                    onSaved={() => refetch()}
                  />
                ),
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
                    description="Dependencies appear here once tickets declare dependsOn relationships."
                  />
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
            {(() => {
              // Only surface counts that actually need attention. Zero rows here
              // just duplicate the stat cards / Progress Summary, so an all-clear
              // project shows a single reassuring line instead of three "0"s.
              const rows = [
                { label: 'Blocked', count: project.needsAttention.blockedCount, alert: true },
                { label: 'Failed', count: project.needsAttention.failedCount, alert: true },
                { label: 'Unanswered questions', count: project.needsAttention.openQuestions, alert: false },
              ].filter((row) => row.count > 0);

              if (rows.length === 0) {
                return <p className="text-sm text-muted-foreground">Nothing needs attention.</p>;
              }

              return (
                <dl className="space-y-3 text-sm">
                  {rows.map((row) => (
                    <div key={row.label} className="flex items-center justify-between">
                      <dt className="text-muted-foreground">{row.label}</dt>
                      <dd
                        className={`font-semibold ${
                          row.alert ? 'text-warning-foreground' : 'text-foreground'
                        }`}
                      >
                        {row.count}
                      </dd>
                    </div>
                  ))}
                </dl>
              );
            })()}
          </SectionCard>

          <SectionCard title="Quick Links">
            <div className="space-y-2 text-sm">
              <Link className="flex items-center gap-2 text-primary hover:underline" to={`/projects/${project.slug}/edit`}>
                <SquarePen className="h-4 w-4" />
                Edit project source
              </Link>
              <Link className="flex items-center gap-2 text-primary hover:underline" to={`/projects/${project.slug}/create/ticket`}>
                <Plus className="h-4 w-4" />
                Create ticket
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

    </div>
  );
}

function TicketCard({
  projectSlug,
  ticket,
  onTicketChange,
}: {
  projectSlug: string;
  ticket: TicketSummary;
  onTicketChange?: () => void;
}) {
  return (
    <Link
      to={`/projects/${projectSlug}/tickets/${ticket.slug}`}
      className="vp-card block rounded-lg border border-border/60 bg-background/80 p-3 transition hover:border-primary/40"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="font-semibold text-foreground">{ticket.title}</h3>
          <p className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground/70" title={ticket.id}>
            {ticket.id.slice(0, 8)}
            <span onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
              <CopyButton value={ticket.id} />
            </span>
          </p>
          <p className="text-sm text-muted-foreground">Updated {formatDate(ticket.updated)}</p>
        </div>
        <span
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <TicketStatusPill
            projectSlug={projectSlug}
            slug={ticket.slug}
            status={ticket.status}
            title={ticket.title}
            className="max-w-[150px]"
            onChange={onTicketChange}
          />
        </span>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <TypeChip type={ticket.type} />
        <span className="rounded-full border border-border/60 px-2.5 py-1 text-xs capitalize text-muted-foreground">
          {ticket.priority}
        </span>
        <span className="rounded-full border border-border/60 px-2.5 py-1 text-xs text-muted-foreground">
          {ticket.assignee ?? 'Unassigned'}
        </span>
        <span className="rounded-full border border-border/60 px-2.5 py-1 text-xs text-muted-foreground">
          {ticket.dependsOn.length} dependencies
        </span>
      </div>
    </Link>
  );
}
